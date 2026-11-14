import { LoaderCircle, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MemoryUploadDialog } from '../components/MemoryUploadDialog.jsx';
import { PasswordGate } from '../components/PasswordGate.jsx';
import { Footer } from '../sections/Footer.jsx';
import { GuestGallery } from '../sections/GuestGallery.jsx';
import { Navigation } from '../sections/Navigation.jsx';

export function MemoriesPage() {
  const [galleryVersion, setGalleryVersion] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const addButton = useRef(null);
  const refreshAfterUpload = useCallback(() => setGalleryVersion((current) => current + 1), []);
  const openUpload = useCallback(() => setUploadOpen(true), []);
  const closeUpload = useCallback(() => {
    setUploadOpen(false);
    if (window.location.hash === '#memories') {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#gallery`);
    }
  }, []);

  useEffect(() => {
    const openFromBookmark = () => { if (window.location.hash === '#memories') openUpload(); };
    openFromBookmark();
    window.addEventListener('hashchange', openFromBookmark);
    return () => window.removeEventListener('hashchange', openFromBookmark);
  }, [openUpload]);

  return (
    <PasswordGate>
      <main className="memoriesPage">
        <Navigation page="memories" />
        <header className="memoriesPageHeader">
          <div>
            <p className="eyebrow">Krisha & Joe</p>
            <h1>Memories</h1>
          </div>
          <button
            aria-controls="memory-upload-dialog"
            aria-expanded={uploadOpen}
            aria-haspopup="dialog"
            className="button primary memoryAddButton"
            onClick={openUpload}
            ref={addButton}
            type="button"
          >
            {isUploading ? <LoaderCircle className="memorySpinner" size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
            {isUploading ? 'Uploading…' : 'Add a memory'}
          </button>
        </header>
        <GuestGallery onAddMemory={openUpload} refreshKey={galleryVersion} />
        <MemoryUploadDialog
          isUploading={isUploading}
          onClose={closeUpload}
          onUploadComplete={refreshAfterUpload}
          onUploadingChange={setIsUploading}
          open={uploadOpen}
          returnFocusRef={addButton}
        />
        <Footer />
      </main>
    </PasswordGate>
  );
}
