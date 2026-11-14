// A confirmed upload is the only source of completion notifications. Progress
// updates and gallery failures must not change the upload's saved receipt.
export async function uploadWithCompletion(upload, { isActive, onSaved, onComplete }) {
  const receipt = await upload();
  if (!isActive()) return receipt;
  onSaved();
  try {
    Promise.resolve(onComplete?.()).catch(() => {});
  } catch { /* The file is already saved; gallery refresh can retry separately. */ }
  return receipt;
}
