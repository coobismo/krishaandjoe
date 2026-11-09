import { useEffect, useRef, useState } from 'react';
import { getUploadLimits, MAX_FILES, uploadPhoto, validatePhoto } from './uploadPhoto.mjs';

const fileKey = (file) => `${file.name}:${file.size}:${file.lastModified}`;

export function usePhotoUploads(endpoint, provider = 'apps-script', uploadCode = '', onUploadsComplete) {
  const limits = getUploadLimits(provider);
  const [files, setFiles] = useState([]);
  const [guestName, setGuestName] = useState('');
  const [selectionErrors, setSelectionErrors] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [notice, setNotice] = useState('');
  const uploadInProgress = useRef(false);
  const stopRequested = useRef(false);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      stopRequested.current = true;
    };
  }, []);

  useEffect(() => {
    if (!isUploading) return;
    function warnBeforeLeaving(event) {
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [isUploading]);

  function addFiles(selectedFiles) {
    if (uploadInProgress.current) return;
    const nextFiles = [...files];
    const errors = [];
    let skippedDuplicates = false;

    for (const file of selectedFiles) {
      const error = validatePhoto(file, limits.maxFileBytes);
      if (error) {
        errors.push(`${file.name}: ${error}`);
        continue;
      }
      if (nextFiles.some((entry) => fileKey(entry.file) === fileKey(file))) {
        skippedDuplicates = true;
        continue;
      }
      if (nextFiles.length >= MAX_FILES) {
        errors.push(`Choose up to ${MAX_FILES} files at a time. Upload or remove some files before adding more.`);
        break;
      }
      nextFiles.push({ file, uploadId: crypto.randomUUID(), status: 'ready', error: '', uploadedBytes: 0 });
    }

    setFiles(nextFiles);
    setSelectionErrors(errors);
    setNotice(skippedDuplicates ? 'Files already in your selection were skipped.' : '');
  }

  function removeFile(uploadId) {
    if (uploadInProgress.current) return;
    setFiles((current) => current.filter((entry) => entry.uploadId !== uploadId));
    setNotice('');
    setSelectionErrors([]);
  }

  function clearUploaded() {
    if (uploadInProgress.current) return;
    setFiles((current) => current.filter((entry) => entry.status !== 'success'));
    setNotice('');
    setSelectionErrors([]);
  }

  async function startUpload(event) {
    event.preventDefault();
    if (uploadInProgress.current || !endpoint) return;
    const pendingFiles = files.filter((entry) => entry.status !== 'success');
    if (!pendingFiles.length) return;

    uploadInProgress.current = true;
    stopRequested.current = false;
    setIsUploading(true);
    setNotice('');
    let failedCount = 0;
    let uploadedCount = 0;
    const updateFile = (uploadId, update) => {
      if (!isMounted.current) return;
      if (uploadedCount > 0 && typeof onUploadsComplete === 'function') onUploadsComplete();
      setFiles((current) => current.map((entry) => (
        entry.uploadId === uploadId ? { ...entry, ...update } : entry
      )));
    };

    try {
      for (const entry of pendingFiles) {
        if (stopRequested.current || !isMounted.current) break;
        // Metadata stays fixed for a resumable upload even if the guest edits
        // their name before retrying a previously started file.
        const entryGuestName = entry.guestName ?? guestName.trim();
        updateFile(entry.uploadId, { status: 'uploading', error: '', guestName: entryGuestName });
        try {
          await uploadPhoto(endpoint, { ...entry, guestName: entryGuestName }, {
            provider,
            uploadCode,
            onProgress: ({ uploadedBytes, phase }) => updateFile(entry.uploadId, { uploadedBytes, phase }),
          });
          updateFile(entry.uploadId, { status: 'success', uploadedBytes: entry.file.size });
          uploadedCount += 1;
        } catch (error) {
          updateFile(entry.uploadId, {
            status: 'error',
            error: error.message || 'We couldn’t confirm this upload. Please try again.',
          });
          failedCount += 1;
        }
      }

      if (!isMounted.current) return;
      if (stopRequested.current) {
        setNotice('Uploads paused. Your remaining files are ready whenever you are.');
      } else if (failedCount) {
        setNotice(`${uploadedCount ? `${uploadedCount} ${uploadedCount === 1 ? 'file was' : 'files were'} saved. ` : ''}Some uploads couldn’t be confirmed. Please retry the remaining files.`);
      } else {
        setNotice('Your memories are saved. Thank you for sharing a little of our day with us!');
      }
    } finally {
      uploadInProgress.current = false;
      if (isMounted.current) setIsUploading(false);
    }
  }

  function pauseUploads() {
    stopRequested.current = true;
    setNotice('Finishing the current file, then pausing your uploads…');
  }

  return {
    files, guestName, setGuestName, selectionErrors, isUploading, notice,
    addFiles, removeFile, clearUploaded, startUpload, pauseUploads,
  };
}
