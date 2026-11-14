import { Camera, Check, Image, LoaderCircle, Upload, Video, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PHOTO_UPLOAD } from '../data/wedding.js';
import { ACCEPTED_FILES, formatFileSize, getPhotoMimeType, getUploadLimits, isUploadEndpoint, MAX_FILES } from '../features/photos/uploadPhoto.mjs';
import { usePhotoUploads } from '../features/photos/usePhotoUploads.js';

function FilePreview({ file }) {
  const [preview, setPreview] = useState('');
  const [failed, setFailed] = useState(false);
  const isVideo = getPhotoMimeType(file).startsWith('video/');

  useEffect(() => {
    if (isVideo) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isVideo]);

  return (
    <span className="memoryPreview" aria-hidden="true">
      {preview && !failed
        ? <img alt="" src={preview} loading="lazy" decoding="async" onError={() => setFailed(true)} />
        : isVideo ? <Video size={22} /> : <Image size={22} />}
    </span>
  );
}

function fileStatus(entry, provider) {
  if (entry.status === 'success') return 'Saved to our album';
  if (entry.status === 'error') return 'Please try again';
  if (entry.status !== 'uploading') return 'Ready to share';
  if (entry.phase === 'confirming') return 'Confirming your upload…';
  if (provider === 'cloud-run') return `Uploading ${Math.floor((entry.uploadedBytes || 0) / entry.file.size * 100)}%`;
  return 'Uploading…';
}

export function PhotoUpload({ onUploadComplete }) {
  const endpoint = PHOTO_UPLOAD.endpoint;
  const { provider, uploadCode } = PHOTO_UPLOAD;
  const limits = getUploadLimits(provider);
  const isConfigured = isUploadEndpoint(endpoint, provider) && (provider !== 'cloud-run' || Boolean(uploadCode));
  const uploads = usePhotoUploads(isConfigured ? endpoint : '', provider, uploadCode, onUploadComplete);
  const inputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const pendingCount = uploads.files.filter((entry) => entry.status !== 'success').length;
  const savedCount = uploads.files.length - pendingCount;
  const canSelect = isConfigured && !uploads.isUploading && uploads.files.length < MAX_FILES;

  function selectFiles(event) {
    uploads.addFiles(Array.from(event.target.files || []));
    event.target.value = '';
  }

  function dropFiles(event) {
    event.preventDefault();
    setIsDragging(false);
    if (canSelect) uploads.addFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <section id="memories" className="section memories" aria-labelledby="memories-title">
      <div className="memoriesIntro">
        <Camera className="memoriesCamera" size={30} strokeWidth={1.4} aria-hidden="true" />
        <p className="eyebrow">Through your eyes</p>
        <h2 id="memories-title">Share your memories</h2>
        <p className="sectionLead">
          The happy tears, the dance-floor moments, the little things we might miss.
          We’d love to see our day through your eyes.
        </p>
      </div>

      <form className="memoriesPanel" onSubmit={uploads.startUpload}>
        <div className="memoryGuestField">
          <label htmlFor="memory-guest-name">Your name <span>(optional)</span></label>
          <input
            autoComplete="name"
            disabled={uploads.isUploading || !isConfigured}
            id="memory-guest-name"
            maxLength={100}
            onChange={(event) => uploads.setGuestName(event.target.value)}
            placeholder="So we know who to thank"
            type="text"
            value={uploads.guestName}
          />
        </div>

        <div
          className={`memoryDropzone${isDragging && canSelect ? ' isDragging' : ''}`}
          onDragOver={(event) => { event.preventDefault(); if (canSelect) setIsDragging(true); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setIsDragging(false); }}
          onDrop={dropFiles}
        >
          <Upload size={28} strokeWidth={1.5} aria-hidden="true" />
          <p className="memoryDropTitle">A little moment. A lasting memory.</p>
          <p className="memoryDropHint" id="memory-file-hint">Choose photos & videos, or drag them here.</p>
          <input
            accept={ACCEPTED_FILES}
            aria-describedby="memory-file-hint memory-file-limits"
            aria-label="Choose wedding photos and videos"
            className="srOnly"
            disabled={!canSelect}
            id="memory-files"
            multiple
            onChange={selectFiles}
            ref={inputRef}
            tabIndex={-1}
            type="file"
          />
          <button className="button secondary memoryChoose" disabled={!canSelect} onClick={() => inputRef.current?.click()} type="button">
            <Image size={17} aria-hidden="true" /> Choose photos & videos
          </button>
          <p className="memoryLimits" id="memory-file-limits">Up to {limits.maxFiles} files at a time · {formatFileSize(limits.maxFileBytes).replace('.0', '')} per file · iPhone photos welcome</p>
        </div>

        {!isConfigured && <p className="memoryNotice">Photo sharing is opening soon. Please check back to share your memories with us.</p>}

        {uploads.selectionErrors.length > 0 && (
          <ul className="memoryErrors" role="alert">
            {uploads.selectionErrors.map((error, index) => <li key={index}>{error}</li>)}
          </ul>
        )}

        {uploads.files.length > 0 && (
          <>
            <div className="memoryQueueHeading">
              <p>{uploads.files.length} {uploads.files.length === 1 ? 'memory' : 'memories'} selected</p>
              {savedCount > 0 && <button className="memoryTextButton" disabled={uploads.isUploading} onClick={uploads.clearUploaded} type="button">Clear uploaded</button>}
            </div>
            <ul className="memoryQueue" aria-label="Selected memories">
              {uploads.files.map((entry) => (
                <li className={`memoryFile memoryFile-${entry.status}`} key={entry.uploadId}>
                  <FilePreview file={entry.file} />
                  <div className="memoryFileInfo">
                    <span className="memoryFileName">{entry.file.name}</span>
                    <span className="memoryFileDetail">
                      {formatFileSize(entry.file.size)} · {fileStatus(entry, provider)}
                    </span>
                    {entry.status === 'uploading' && provider === 'cloud-run' && (
                      <progress className="memoryProgress" aria-label={`Upload progress for ${entry.file.name}`} max={entry.file.size} value={entry.uploadedBytes || 0} />
                    )}
                    {entry.error && <span className="memoryFileError">{entry.error}</span>}
                  </div>
                  {entry.status === 'success' ? <Check className="memorySavedIcon" size={20} aria-label="Uploaded" />
                    : entry.status === 'uploading' ? <LoaderCircle className="memorySpinner" size={20} aria-label="Uploading" />
                      : <button aria-label={`Remove ${entry.file.name}`} className="memoryRemove" disabled={uploads.isUploading} onClick={() => uploads.removeFile(entry.uploadId)} type="button"><X size={18} aria-hidden="true" /></button>}
                </li>
              ))}
            </ul>
            <div className="memoryUploadActions">
              <p className="memoryCount" role="status" aria-atomic="true">{savedCount} of {uploads.files.length} uploaded</p>
              <button className="button primary memorySubmit" disabled={!isConfigured || uploads.isUploading || pendingCount === 0} type="submit">
                {uploads.isUploading ? <LoaderCircle className="memorySpinner" size={18} aria-hidden="true" /> : <Upload size={18} aria-hidden="true" />}
                {uploads.isUploading ? 'Sharing your memories…' : pendingCount ? `Upload ${pendingCount} ${pendingCount === 1 ? 'file' : 'files'}` : 'All memories shared'}
              </button>
              {uploads.isUploading && <button className="memoryTextButton" onClick={uploads.pauseUploads} type="button">Pause after this file</button>}
            </div>
          </>
        )}

        <p className="memoryFeedback" role="status" aria-atomic="true">{uploads.notice}</p>
        <p className="memoryFootnote">For Krisha & Joe’s keepsake album. No Google sign-in needed.</p>
      </form>
    </section>
  );
}
