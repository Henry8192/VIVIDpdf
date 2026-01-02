// --- Icon Components ---
export const Icons = {
  Upload: () => <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>,
  Play: () => <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>,
  Pause: () => <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>,
  Voice: () => <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>,
  Crop: () => <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"></path><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"></path></svg>,
  Close: () => <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3"  viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>,
  Rotate:(props) => (
<svg
    viewBox="0 0 256 256"
    fill="currentColor"
    height="1em"
    width="1em"
    {...props}
  >
    <path d="M216.7,75.4C236.2,95,246,118.6,246,146.3c0,27.7-9.8,51.4-29.3,70.9c-19.2,19.5-42.9,29.3-71.2,29.3c-17.1,0-33.1-4.2-48.1-12.6l16.7-16.2c9.4,4.6,19.9,6.8,31.4,6.8c21.6,0,40.1-7.7,55.5-23c15-15,22.5-33.3,22.5-55c0-21.6-7.5-40.1-22.5-55.5c-15.4-15.4-33.8-23-55.5-23v36.1L98.4,57.1l47.1-47.6v36.1C173.8,45.6,197.5,55.5,216.7,75.4L216.7,75.4z M41.9,145l40.8,40.8l40.8-40.8l-40.8-40.8L41.9,145z M82.8,72.8L155,145l-72.2,72.2L10,145L82.8,72.8z" />
  </svg>),
};
