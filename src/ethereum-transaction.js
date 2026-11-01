import { Transaction } from 'ethers';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

function fromRpcQuantity(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`Transaction is missing a valid ${label}.`);
  }
  return BigInt(value);
}

/** Recover the signer public key from an Ethereum JSON-RPC transaction object. */
export function recoverEthereumTransactionPublicKey(rpcTransaction) {
  if (!rpcTransaction || typeof rpcTransaction !== 'object') throw new Error('No transaction data was returned.');
  if (!rpcTransaction.r || !rpcTransaction.s || rpcTransaction.v == null) {
    throw new Error('Transaction has no recoverable signature.');
  }

  const type = Number(fromRpcQuantity(rpcTransaction.type ?? '0x0', 'transaction type'));
  if (!Number.isInteger(type) || type < 0 || type > 3) {
    throw new Error(`Transaction type ${type} is not supported for public-key extraction.`);
  }

  const txLike = {
    type,
    chainId: rpcTransaction.chainId ? fromRpcQuantity(rpcTransaction.chainId, 'chain ID') : undefined,
    nonce: Number(fromRpcQuantity(rpcTransaction.nonce, 'nonce')),
    gasLimit: fromRpcQuantity(rpcTransaction.gas, 'gas limit'),
    to: rpcTransaction.to || null,
    value: fromRpcQuantity(rpcTransaction.value, 'value'),
    data: rpcTransaction.input ?? '0x',
    accessList: type >= 1 ? (rpcTransaction.accessList ?? []) : undefined,
    signature: {
      r: rpcTransaction.r,
      s: rpcTransaction.s,
      v: fromRpcQuantity(rpcTransaction.v, 'signature v'),
    },
  };

  if (type <= 1) {
    txLike.gasPrice = fromRpcQuantity(rpcTransaction.gasPrice, 'gas price');
  } else {
    txLike.maxFeePerGas = fromRpcQuantity(rpcTransaction.maxFeePerGas, 'max fee per gas');
    txLike.maxPriorityFeePerGas = fromRpcQuantity(rpcTransaction.maxPriorityFeePerGas, 'max priority fee per gas');
  }
  if (type === 3) {
    txLike.maxFeePerBlobGas = fromRpcQuantity(rpcTransaction.maxFeePerBlobGas, 'max fee per blob gas');
    txLike.blobVersionedHashes = rpcTransaction.blobVersionedHashes ?? [];
  }

  let tx;
  try {
    tx = Transaction.from(txLike);
  } catch (error) {
    throw new Error(`Could not reconstruct the signed transaction: ${error?.message ?? String(error)}`);
  }
  if (!tx.signature) throw new Error('Transaction signature could not be decoded.');

  const signatureBytes = hexToBytes(`${tx.signature.r.slice(2)}${tx.signature.s.slice(2)}`);
  const recoveredSignature = secp256k1.Signature.fromBytes(
    Uint8Array.from([tx.signature.yParity, ...signatureBytes]),
    'recovered',
  );
  const publicKey = recoveredSignature.recoverPublicKey(hexToBytes(tx.unsignedHash.slice(2))).toBytes(false);
  const address = `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(12))}`;
  return { publicKey: `0x${bytesToHex(publicKey)}`, address };
}
