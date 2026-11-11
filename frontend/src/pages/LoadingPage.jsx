export default function LoadingPage({ active = false, message, progress }) {
  return (
    <main className={`screen${active ? ' active' : ''}`}>
      <div className="loading-center" aria-live="polite">
        <div className="nta-spinner" role="status" aria-label="Processing" />
        <div className="loading-title">{message}</div>
        <div className="loading-sub">{message?.toLowerCase().includes('preparing extracted') ? 'Extraction returned. Organizing questions and source images.' : progress >= 50 && progress < 100 ? 'Upload complete. Server processing is underway; live extraction progress is not available yet.' : 'Sending the PDF and preparing the extraction request.'}</div>
        <div
          className="load-track"
          role="progressbar"
          aria-label="PDF processing progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div className="load-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>
    </main>
  );
}
