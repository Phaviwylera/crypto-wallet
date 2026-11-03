# -*- coding: utf-8 -*-
"""Interactive, exact scalar-space map of recently active Ethereum addresses.

Designed for Google Colab or Jupyter. No private keys are generated, requested,
or recovered: a public Ethereum address does not reveal its private key.

Colab dependencies (normally preinstalled):
    !pip install numpy plotly pandas ipywidgets anywidget

The map samples recent mainnet blocks through public JSON-RPC endpoints. It is
not a complete registry of all Ethereum wallets or all currently funded accounts.
"""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal
from html import escape
import json
import re
from typing import Any, Iterable, Sequence
from urllib.request import Request, urlopen


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

GRID_SIZE = 512
GRID_BITS = 9
CELL_COUNT = GRID_SIZE * GRID_SIZE
MAX_CELL = CELL_COUNT - 1
ADDRESS_SHIFT = 96
MAX_ADDRESS = (1 << 160) - 1
# Public addresses occupy aligned 256-bit values from zero through this endpoint.
MAX_SCALAR = MAX_ADDRESS << ADDRESS_SHIFT

BLOCKS_TO_SAMPLE = 2
MAX_ADDRESSES = 100
RPC_TIMEOUT_SECONDS = 25
RPC_BATCH_SIZE = 40
RPC_URLS = (
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://rpc.flashbots.net",
)

ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


# ---------------------------------------------------------------------------
# Exact integer mapping — no floats are used anywhere in the scalar mapping.
#
# Mapping: cell = floor(scalar * 262143 / ((2^160-1) << 96))
# For scalar = address << 96, this reduces exactly to:
#   cell = floor(address * 262143 / (2^160-1))
# The maximum mapped scalar and maximum cell are both inclusive endpoints.
# ---------------------------------------------------------------------------


def _ceil_div(numerator: int, denominator: int) -> int:
    return (numerator + denominator - 1) // denominator


def scalar_to_cell(scalar: int) -> int:
    """Return the exact Morton cell for an address-mapped 256-bit scalar."""
    if not isinstance(scalar, int) or isinstance(scalar, bool):
        raise TypeError("scalar must be an integer")
    if not 0 <= scalar <= MAX_SCALAR:
        raise ValueError("scalar must be in [0, (2^160-1) << 96]")
    return scalar * MAX_CELL // MAX_SCALAR


def cell_to_scalar_range(cell: int) -> tuple[int, int]:
    """Return the exact inclusive scalar interval mapped to ``cell``.

    If k = floor(s * C / M), then:
        ceil(k*M/C) <= s <= ceil((k+1)*M/C)-1
    where C = 262143 and M = (2^160-1) << 96.
    """
    if not isinstance(cell, int) or isinstance(cell, bool):
        raise TypeError("cell must be an integer")
    if not 0 <= cell <= MAX_CELL:
        raise ValueError(f"cell must be in [0, {MAX_CELL}]")

    lower = _ceil_div(cell * MAX_SCALAR, MAX_CELL)
    upper = _ceil_div((cell + 1) * MAX_SCALAR, MAX_CELL) - 1
    return max(0, lower), min(MAX_SCALAR, upper)


def cell_to_grid(cell: int) -> tuple[int, int]:
    """Deinterleave an 18-bit Morton cell into 9-bit x and y coordinates."""
    if not 0 <= cell <= MAX_CELL:
        raise ValueError(f"cell must be in [0, {MAX_CELL}]")
    x = 0
    y = 0
    for bit in range(GRID_BITS):
        x |= ((cell >> (2 * bit)) & 1) << bit
        y |= ((cell >> (2 * bit + 1)) & 1) << bit
    return x, y


def grid_to_cell(x: int, y: int) -> int:
    """Interleave 9-bit x and y coordinates into an 18-bit Morton cell."""
    if not (0 <= x < GRID_SIZE and 0 <= y < GRID_SIZE):
        raise ValueError(f"x and y must be in [0, {GRID_SIZE - 1}]")
    cell = 0
    for bit in range(GRID_BITS):
        cell |= ((x >> bit) & 1) << (2 * bit)
        cell |= ((y >> bit) & 1) << (2 * bit + 1)
    return cell


def scalar_to_grid(scalar: int) -> tuple[int, int]:
    return cell_to_grid(scalar_to_cell(scalar))


def grid_to_scalar_range(x: int, y: int) -> tuple[int, int]:
    """Replacement for the old approximate grid_to_scalar function."""
    return cell_to_scalar_range(grid_to_cell(x, y))


def normalize_address(address: str | None) -> str | None:
    if not address:
        return None
    candidate = address if address.startswith("0x") else "0x" + address
    if not ADDRESS_RE.fullmatch(candidate):
        return None
    return candidate.lower()


def address_to_scalar(address: str) -> int:
    """Map a public 160-bit address into 256-bit space by appending 96 zeros."""
    normalized = normalize_address(address)
    if normalized is None:
        raise ValueError(f"Invalid Ethereum address: {address!r}")
    return int(normalized[2:], 16) << ADDRESS_SHIFT


def address_range_for_cell(cell: int) -> tuple[int, int]:
    """Return the inclusive 160-bit address interval represented by a cell."""
    scalar_lower, scalar_upper = cell_to_scalar_range(cell)
    address_lower = _ceil_div(scalar_lower, 1 << ADDRESS_SHIFT)
    address_upper = scalar_upper >> ADDRESS_SHIFT
    return address_lower, address_upper


# ---------------------------------------------------------------------------
# Public Ethereum JSON-RPC collection
# ---------------------------------------------------------------------------


class EthereumRPC:
    """Small JSON-RPC client with endpoint failover and bounded batch calls."""

    def __init__(
        self,
        urls: Sequence[str] = RPC_URLS,
        timeout: int = RPC_TIMEOUT_SECONDS,
    ) -> None:
        if not urls:
            raise ValueError("At least one Ethereum RPC URL is required")
        self.urls = tuple(urls)
        self.timeout = timeout
        self.preferred_url: str | None = None

    def _post(self, payload: Any) -> Any:
        endpoints = list(self.urls)
        if self.preferred_url in endpoints:
            endpoints.remove(self.preferred_url)
            endpoints.insert(0, self.preferred_url)

        errors: list[str] = []
        for endpoint in endpoints:
            try:
                request = Request(
                    endpoint,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(request, timeout=self.timeout) as response:
                    result = json.loads(response.read().decode("utf-8"))

                responses = result if isinstance(result, list) else [result]
                for item in responses:
                    if not isinstance(item, dict):
                        raise ValueError("Malformed JSON-RPC response")
                    if "error" in item:
                        raise RuntimeError(str(item["error"]))
                    if "result" not in item:
                        raise ValueError("JSON-RPC response has no result")

                self.preferred_url = endpoint
                return result
            except Exception as exc:  # try the next independent public endpoint
                errors.append(f"{endpoint}: {exc}")

        raise RuntimeError("All Ethereum RPC endpoints failed:\n" + "\n".join(errors))

    def call(self, method: str, params: Sequence[Any]) -> Any:
        return self._post(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": list(params)}
        )["result"]

    def batch(self, calls: Iterable[tuple[str, Sequence[Any]]]) -> list[Any]:
        call_list = list(calls)
        results: list[Any] = []
        for start in range(0, len(call_list), RPC_BATCH_SIZE):
            chunk = call_list[start : start + RPC_BATCH_SIZE]
            payload = [
                {
                    "jsonrpc": "2.0",
                    "id": start + offset,
                    "method": method,
                    "params": list(params),
                }
                for offset, (method, params) in enumerate(chunk)
            ]
            response = self._post(payload)
            by_id = {item["id"]: item["result"] for item in response}
            results.extend(by_id[start + offset] for offset in range(len(chunk)))
        return results


def fetch_recent_wallets(
    rpc: EthereumRPC,
    blocks_to_sample: int = BLOCKS_TO_SAMPLE,
    max_addresses: int = MAX_ADDRESSES,
) -> tuple[list[dict[str, Any]], int]:
    """Collect public addresses observed as senders/recipients in recent blocks.

    This is a recent-activity sample, not a claim that every address is an EOA,
    funded, controlled by a private key, or a complete list of live wallets.
    """
    if not 1 <= blocks_to_sample <= 20:
        raise ValueError("blocks_to_sample must be between 1 and 20")
    if not 1 <= max_addresses <= 1000:
        raise ValueError("max_addresses must be between 1 and 1000")

    latest = rpc.call("eth_getBlockByNumber", ["latest", True])
    latest_number = int(latest["number"], 16)
    observed: dict[str, dict[str, Any]] = {}

    for offset in range(blocks_to_sample):
        block = latest if offset == 0 else rpc.call(
            "eth_getBlockByNumber", [hex(latest_number - offset), True]
        )
        block_number = int(block["number"], 16)
        for transaction in block.get("transactions", []):
            for role in ("from", "to"):
                address = normalize_address(transaction.get(role))
                if address is None:
                    continue
                entry = observed.setdefault(
                    address,
                    {
                        "address": address,
                        "blocks": set(),
                        "sample_tx": transaction.get("hash"),
                    },
                )
                entry["blocks"].add(block_number)
                if len(observed) >= max_addresses:
                    break
            if len(observed) >= max_addresses:
                break
        if len(observed) >= max_addresses:
            break

    addresses = list(observed)
    if not addresses:
        raise RuntimeError("The sampled blocks contained no valid public addresses")

    # Metadata is public and optional. A provider failure must not change the map.
    balances: list[Any] = [None] * len(addresses)
    codes: list[Any] = [None] * len(addresses)
    try:
        balances = rpc.batch(
            ("eth_getBalance", [address, "latest"]) for address in addresses
        )
        codes = rpc.batch(("eth_getCode", [address, "latest"]) for address in addresses)
    except RuntimeError as exc:
        print(f"Warning: balance/code metadata unavailable: {exc}")

    wallets: list[dict[str, Any]] = []
    for index, address in enumerate(addresses):
        scalar = address_to_scalar(address)
        cell = scalar_to_cell(scalar)
        x, y = cell_to_grid(cell)
        balance_wei = int(balances[index], 16) if balances[index] else None
        code = codes[index]
        wallets.append(
            {
                **observed[address],
                "blocks": sorted(observed[address]["blocks"], reverse=True),
                "mapped_scalar": scalar,
                "cell": cell,
                "x": x,
                "y": y,
                "balance_wei": balance_wei,
                "code_kind": (
                    "Unknown"
                    if code is None
                    else "No code (EOA-like)"
                    if code == "0x"
                    else "Contract/code present"
                ),
            }
        )

    wallets.sort(key=lambda wallet: (wallet["cell"], wallet["address"]))
    return wallets, latest_number


# ---------------------------------------------------------------------------
# Colab / Jupyter interactive rendering
# ---------------------------------------------------------------------------


def _format_eth(balance_wei: int | None) -> str:
    if balance_wei is None:
        return "Unavailable"
    value = Decimal(balance_wei) / Decimal(10**18)
    return f"{value:,.8f}".rstrip("0").rstrip(".") + " ETH"


def _code(value: str) -> str:
    return (
        '<code style="white-space:normal;overflow-wrap:anywhere;'
        'word-break:break-all">' + escape(value) + "</code>"
    )


def render_cell_details(
    x: int,
    y: int,
    wallets_by_cell: dict[int, list[dict[str, Any]]],
) -> str:
    """Build safe HTML for any clicked cell, including an empty cell."""
    cell = grid_to_cell(x, y)
    lower, upper = cell_to_scalar_range(cell)
    address_lower, address_upper = address_range_for_cell(cell)
    wallets = wallets_by_cell.get(cell, [])

    parts = [
        '<div style="font:13px/1.45 monospace;color:#e6edf3;'
        'background:#0b0e14;padding:14px;border:1px solid #30363d;'
        'border-radius:8px">',
        f"<b>Grid coordinate:</b> ({x}, {y})<br>",
        f"<b>Morton cell:</b> {cell:,}<br>",
        "<b>Exact inclusive 256-bit mapped-scalar range:</b><br>",
        "Lower: " + _code(f"0x{lower:064x}") + "<br>",
        "Upper: " + _code(f"0x{upper:064x}") + "<br>",
        f"<b>Scalars in cell:</b> {upper - lower + 1:,}<br>",
        "<b>Corresponding public-address interval:</b><br>",
        "First: " + _code(f"0x{address_lower:040x}") + "<br>",
        "Last: " + _code(f"0x{address_upper:040x}") + "<br>",
        f"<b>Recently sampled addresses in this cell:</b> {len(wallets)}",
    ]

    if not wallets:
        parts.append(
            "<p>No address from the recent-block sample maps here. This does "
            "<b>not</b> prove that the cell is empty on the blockchain.</p>"
        )

    for wallet in wallets:
        parts.extend(
            [
                '<hr style="border-color:#30363d">',
                "<b>Public address:</b> " + _code(wallet["address"]) + "<br>",
                "<b>Mapped scalar (address &lt;&lt; 96):</b><br>",
                _code(f"0x{wallet['mapped_scalar']:064x}") + "<br>",
                f"<b>Balance:</b> {escape(_format_eth(wallet['balance_wei']))}<br>",
                f"<b>Code status:</b> {escape(wallet['code_kind'])}<br>",
                "<b>Observed in blocks:</b> "
                + escape(", ".join(str(block) for block in wallet["blocks"]))
                + "<br>",
                "<b>Sample transaction:</b> "
                + _code(wallet["sample_tx"] or "Unavailable")
                + "<br>",
                "<b>Private key:</b> Not derivable from a public address, "
                "mapped scalar, coordinate, or scalar range.",
            ]
        )

    parts.append("</div>")
    return "".join(parts)


def show_interactive_map(
    wallets: list[dict[str, Any]], latest_block: int
) -> Any:
    """Display a clickable FigureWidget and a public-address table."""
    import numpy as np
    import pandas as pd
    import plotly.graph_objects as go
    from IPython.display import display
    from ipywidgets import HTML, VBox

    # Required by current Colab versions for third-party widget callbacks.
    try:
        from google.colab import output

        output.enable_custom_widget_manager()
    except ImportError:
        pass

    wallets_by_cell: dict[int, list[dict[str, Any]]] = defaultdict(list)
    matrix = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.uint32)
    for wallet in wallets:
        wallets_by_cell[wallet["cell"]].append(wallet)
        matrix[wallet["y"], wallet["x"]] += 1

    figure = go.FigureWidget(
        data=go.Heatmap(
            z=np.log1p(matrix),
            customdata=matrix,
            x=list(range(GRID_SIZE)),
            y=list(range(GRID_SIZE)),
            colorscale="Electric",
            showscale=False,
            hovertemplate=(
                "Grid (%{x}, %{y})<br>"
                "Sampled addresses: %{customdata}<br>"
                "Click for exact scalar range<extra></extra>"
            ),
        )
    )
    figure.update_layout(
        title=(
            "Recently Active Ethereum Addresses — Exact Scalar Cells"
            f"<br><sup>Latest sampled block: {latest_block:,}; "
            "click any occupied or empty cell</sup>"
        ),
        title_font_color="cyan",
        xaxis=dict(title="Grid X", color="white", showgrid=False),
        yaxis=dict(
            title="Grid Y",
            color="white",
            showgrid=False,
            scaleanchor="x",
            autorange="reversed",
        ),
        paper_bgcolor="#0b0e14",
        plot_bgcolor="#0b0e14",
        width=800,
        height=800,
        margin=dict(l=55, r=35, t=85, b=50),
    )

    details = HTML(
        value=(
            '<div style="color:#e6edf3;background:#0b0e14;padding:12px">'
            "Click any grid point to inspect its exact inclusive scalar range. "
            "Public addresses never reveal private keys.</div>"
        )
    )

    def on_click(trace: Any, points: Any, selector: Any) -> None:
        if not points.xs or not points.ys:
            return
        x = int(points.xs[0])
        y = int(points.ys[0])
        details.value = render_cell_details(x, y, wallets_by_cell)

    figure.data[0].on_click(on_click)
    display(VBox([figure, details]))

    rows = []
    for wallet in wallets:
        lower, upper = cell_to_scalar_range(wallet["cell"])
        rows.append(
            {
                "Public Address": wallet["address"],
                "Grid Coordinates": f"({wallet['x']}, {wallet['y']})",
                "Morton Cell": wallet["cell"],
                "Mapped 256-bit Scalar": f"0x{wallet['mapped_scalar']:064x}",
                "Cell Scalar Lower": f"0x{lower:064x}",
                "Cell Scalar Upper": f"0x{upper:064x}",
                "Balance": _format_eth(wallet["balance_wei"]),
                "Code Status": wallet["code_kind"],
                "Observed Blocks": ", ".join(map(str, wallet["blocks"])),
                "Sample Transaction": wallet["sample_tx"],
                "Private Key": "Not derivable from public data",
            }
        )

    frame = pd.DataFrame(rows)
    try:
        from google.colab import data_table

        data_table.enable_dataframe_formatter()
    except ImportError:
        pass
    display(frame)
    return figure, details, frame


def main() -> Any:
    print("Fetching recently active public Ethereum addresses from mainnet...")
    rpc = EthereumRPC()
    wallets, latest_block = fetch_recent_wallets(rpc)
    print(
        f"Mapped {len(wallets)} unique public addresses through block "
        f"{latest_block:,} using endpoint {rpc.preferred_url}."
    )
    print(
        "This is a recent-activity sample, not all live wallets. "
        "Private keys cannot be derived from these public addresses."
    )
    return show_interactive_map(wallets, latest_block)


if __name__ == "__main__":
    main()
