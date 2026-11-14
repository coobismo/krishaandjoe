import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { PhotoUpload } from '../sections/PhotoUpload.jsx';

export function MemoryUploadDialog({ open, onClose, onUploadComplete, onUploadingChange, isUploading, returnFocusRef }) {
  const dialog = useRef(null);
  const closeButton = useRef(null);

  useEffect(() => {
    if (!open) return;
    const modal = dialog.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    modal.showModal();
    closeButton.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      modal.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
      else returnFocusRef.current?.focus();
    };
  }, [open, returnFocusRef]);

  return (
    <dialog
      aria-labelledby="memories-title"
      className="memoryUploadDialog"
      id="memory-upload-dialog"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      ref={dialog}
    >
      <div className="memoryUploadDialogBar">
        <button aria-label="Close upload" className="memoryUploadDialogClose" onClick={onClose} ref={closeButton} type="button">
          <X size={22} aria-hidden="true" />
        </button>
      </div>
      <div className="memoryUploadDialogBody">
        {/* Keep the form mounted when closed so queued files and active uploads survive. */}
        <PhotoUpload compact onUploadComplete={onUploadComplete} onUploadingChange={onUploadingChange} />
        {isUploading && <p className="memoryUploadDialogHint">Uploads continue while you browse the gallery.</p>}
      </div>
    </dialog>
  );
}
