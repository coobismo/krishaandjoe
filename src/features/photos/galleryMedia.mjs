export const GALLERY_VIDEO_MIME_TYPES = new Set([
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v',
  'video/3gpp', 'video/3gpp2',
]);

export const isGalleryVideo = (photo) => GALLERY_VIDEO_MIME_TYPES.has(photo?.mimeType);
