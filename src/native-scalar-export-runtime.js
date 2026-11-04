// Shared, non-secret contract between the native binary, export API, and UI.
// Keep the version/capability strings in native/seedlab-eth-export.c in sync.
export const NATIVE_SCALAR_EXPORT_VERSION = '1.1.0';
export const NATIVE_WIDE_RANGE_SAMPLE_CAPABILITY = 'wide-range-random-sample';
export const NATIVE_SCALAR_EXPORT_UPGRADE_MESSAGE = 'The export service is still using an older native exporter without wide-range random sampling. Rebuild and restart the independent scalar-export service (scripts/seedlab-ec2-scalar-export-setup.sh on EC2); refreshing the page or changing TXT/CSV cannot update the server binary.';

export function parseNativeScalarExportVersion(stdout) {
  const text = String(stdout ?? '');
  const version = text.match(/^seedlab-eth-export (\d+\.\d+\.\d+)\b/m)?.[1] || 'unknown';
  const capabilityLine = text.match(/^Native capabilities: (.+)$/m)?.[1] || '';
  const capabilities = capabilityLine.split(',').map((item) => item.trim()).filter(Boolean);
  const supportsWideRangeSample = capabilities.includes(NATIVE_WIDE_RANGE_SAMPLE_CAPABILITY);
  return { version, capabilities, supportsWideRangeSample };
}
