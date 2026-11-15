const byteCount = (value, size) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, size) : 0;

export function uploadProgress(entry, provider = 'cloud-run') {
  const size = Number.isSafeInteger(entry.file?.size) && entry.file.size > 0 ? entry.file.size : 1;
  const acknowledged = byteCount(entry.uploadedBytes, size);
  const sent = entry.sentBytes === undefined ? acknowledged : byteCount(entry.sentBytes, size);
  const percent = entry.status === 'success' ? 100 : Math.min(99, Math.floor(Math.max(acknowledged, sent) / size * 100));
  const indeterminate = entry.status === 'uploading' && provider === 'cloud-run' && entry.phase === 'preparing';
  let label;
  if (entry.status === 'success') label = 'Saved to our album';
  else if (entry.status === 'error') label = 'Please try again';
  else if (entry.status !== 'uploading') label = 'Ready to share';
  else if (provider !== 'cloud-run') label = 'Uploading…';
  else if (entry.phase === 'preparing') label = 'Preparing upload…';
  else if (entry.phase === 'saving') label = 'Saving to our album…';
  else if (entry.phase === 'confirming') label = 'Checking your upload…';
  else if (entry.phase === 'retrying') label = 'Reconnecting…';
  else label = `Uploading ${percent}%`;
  return { percent, indeterminate, label };
}
