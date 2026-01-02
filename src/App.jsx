import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import PDFPage from './PDFPage';
import { Icons } from './Icons';
import './App.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;

const App = () => {
  const [pdf, setPdf] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [rate, setRate] = useState(1.0);
  const [isDragging, setIsDragging] = useState(false);
  
  // Navigation State
  const [numPages, setNumPages] = useState(0);
  const [activePage, setActivePage] = useState(1);
  const [jumpInput, setJumpInput] = useState("1");
  const [isInputFocused, setIsInputFocused] = useState(false);

  // Zoom / View State
  const [scale, setScale] = useState(1.5);
  const [zoomInput, setZoomInput] = useState("150"); // For the % input box
  const [fitMode, setFitMode] = useState('custom'); // 'width', 'height', 'custom'

  // TTS State
  const [voices, setVoices] = useState([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState("");
  const [currentTokens, setCurrentTokens] = useState([]);
  const [activeTokenId, setActiveTokenId] = useState(null);

  // Skip State
  const [isMarkingMode, setIsMarkingMode] = useState(false);
  const [skipZones, setSkipZones] = useState([]);

  // Refs
  const isPlayingRef = useRef(false); 
  const rateRef = useRef(1.0);
  const audioMapRef = useRef([]); 
  const isSwitchingRef = useRef(false);
  const synth = window.speechSynthesis;
  const pageRefs = useRef({}); 
  const viewportRef = useRef(null); // Ref for the scroll container
  
  const pageTokensMap = useRef(new Map());
  const waitingForPageRef = useRef(null);

  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { rateRef.current = rate; }, [rate]);

  // Sync Zoom Input when scale changes programmatically (e.g. via Fit button)
  useEffect(() => {
      setZoomInput(Math.round(scale * 100).toString());
  }, [scale]);

  useEffect(() => {
    if (!isInputFocused) setJumpInput(String(activePage));
  }, [activePage, isInputFocused]);

  useEffect(() => {
    const loadVoices = () => {
      const available = window.speechSynthesis.getVoices();
      setVoices(available);
      if (available.length > 0 && !selectedVoiceURI) {
        const defaultVoice = available.find(v => v.default) || available[0];
        setSelectedVoiceURI(defaultVoice?.voiceURI || "");
      }
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => { window.speechSynthesis.onvoiceschanged = null; };
  }, [selectedVoiceURI]);

  // --- Zoom Handlers ---
  const updateScale = (newScale) => {
      const clamped = Math.min(Math.max(newScale, 0.5), 5.0); // Limit between 50% and 500%
      setScale(clamped);
      setFitMode('custom');
  };

  const handleZoomIn = () => updateScale(scale + 0.1);
  const handleZoomOut = () => updateScale(scale - 0.1);

  const handleZoomInputChange = (e) => setZoomInput(e.target.value);
  
  const handleZoomInputBlur = () => {
      const val = parseInt(zoomInput, 10);
      if (!isNaN(val)) {
          updateScale(val / 100);
      } else {
          setZoomInput(Math.round(scale * 100).toString());
      }
  };

  const handleZoomInputKeyDown = (e) => {
      if (e.key === 'Enter') {
          e.target.blur();
      }
  };

  const toggleFitMode = async () => {
    if (!pdf || !viewportRef.current) return;

    try {
        // Fetch current page to get its natural dimensions
        const page = await pdf.getPage(activePage);
        const unscaledViewport = page.getViewport({ scale: 1.0 });
        
        const containerWidth = viewportRef.current.clientWidth;
        const containerHeight = viewportRef.current.clientHeight;
        
        // Subtract generic padding (e.g. 40px) for scrollbars/margins
        const pad = 40; 
        
        if (fitMode === 'width') {
            // Switch to Height Fit
            const newScale = (containerHeight - pad) / unscaledViewport.height;
            setScale(newScale);
            setFitMode('height');
        } else {
            // Switch to Width Fit (Default from custom or height)
            const newScale = (containerWidth - pad) / unscaledViewport.width;
            setScale(newScale);
            setFitMode('width');
        }
    } catch (err) {
        console.error("Error calculating fit:", err);
    }
  };

  // --- Existing Logic ---

  const handleAddSkipZone = useCallback((zone) => {
      setSkipZones(prev => [...prev, zone]);
  }, []);

  const handleRemoveSkipZone = useCallback((id) => {
      setSkipZones(prev => prev.filter(z => z.id !== id));
  }, []);

  const handlePageTokensRegistered = useCallback((pageNum, tokens) => {
    pageTokensMap.current.set(pageNum, tokens);
    if (waitingForPageRef.current === pageNum && isPlayingRef.current) {
        waitingForPageRef.current = null;
        speakFromToken(null, tokens, pageNum);
    }
  }, []);

  const loadFromBlob = async (blob) => {
    try {
        const data = await blob.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data });
        const pdfDoc = await loadingTask.promise;
        
        setPdf(pdfDoc);
        setNumPages(pdfDoc.numPages);
        setActivePage(1);
        setJumpInput("1");
        
        // Reset View
        setScale(1.5);
        setFitMode('custom');

        setCurrentTokens([]);
        setActiveTokenId(null);
        setIsPlaying(false);
        pageTokensMap.current.clear();
        waitingForPageRef.current = null;
        
        setSkipZones([]);
        synth.cancel();
    } catch (error) {
        console.error("Error loading PDF:", error);
        alert("Failed to load PDF. Please ensure it is a valid file.");
    }
  };

  const onFileChange = (e) => {
    const file = e.target.files[0];
    if (file) loadFromBlob(file);
  };

  const handleDragOver = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0 && files[0].type === "application/pdf") {
        loadFromBlob(files[0]);
    } else {
        alert("Please drop a valid PDF file.");
    }
  };

  const registerPageRef = (num, el) => { pageRefs.current[num] = el; };
  const notifyPageVisible = useCallback((pageNum) => { setActivePage(pageNum); }, []);

  const handleJumpKey = (e) => {
      if (e.key === 'Enter') {
          const page = parseInt(jumpInput);
          if (page >= 1 && page <= numPages && pageRefs.current[page]) {
              pageRefs.current[page].scrollIntoView({ behavior: 'smooth', block: 'start' });
              e.target.blur(); 
          }
      }
  };

  const handleTokenClick = useCallback((pageTokens, clickedTokenId, pageNum) => {
      setCurrentTokens(pageTokens);
      isSwitchingRef.current = true;
      synth.cancel();
      setIsPlaying(true);
      isPlayingRef.current = true;
      waitingForPageRef.current = null;
      speakFromToken(clickedTokenId, pageTokens, pageNum);
      setTimeout(() => { isSwitchingRef.current = false; }, 200);
  }, [voices, selectedVoiceURI, rate]);

  const speakFromToken = (startTokenId, tokensToRead, pageNum) => {
    if (!isPlayingRef.current) return;
    setCurrentTokens(tokensToRead); 
    let script = "";
    const map = []; 
    let startIndexInArray = 0;
    if (startTokenId) {
        startIndexInArray = tokensToRead.findIndex(t => t.id === startTokenId);
        if (startIndexInArray === -1) startIndexInArray = 0;
    }
    for (let i = startIndexInArray; i < tokensToRead.length; i++) {
        const token = tokensToRead[i];
        if (!token) continue;
        const start = script.length;
        const textToRead = token.spokenText;
        const end = start + textToRead.length;
        map.push({ start, end, token });
        script += textToRead + " "; 
    }
    audioMapRef.current = map;
    if (!script.trim()) { handlePageEnd(pageNum); return; }

    const utter = new SpeechSynthesisUtterance(script);
    utter.rate = rateRef.current;
    const targetVoice = voices.find(v => v.voiceURI === selectedVoiceURI);
    if (targetVoice) { utter.voice = targetVoice; utter.lang = targetVoice.lang; }
    utter.onboundary = (event) => {
        if (!isPlayingRef.current) { synth.cancel(); return; }
        const currentIdx = event.charIndex;
        const entry = audioMapRef.current.find(m => currentIdx >= m.start && currentIdx < m.end);
        if (entry) setActiveTokenId(entry.token.id);
    };
    utter.onend = () => {
        if (isSwitchingRef.current || !isPlayingRef.current) return;
        handlePageEnd(pageNum);
    };
    utter.onerror = () => setIsPlaying(false);
    synth.speak(utter);
  };

  const handlePageEnd = (finishedPageNum) => {
      if (finishedPageNum < numPages) {
          const nextPage = finishedPageNum + 1;
          setActivePage(nextPage);
          if (pageRefs.current[nextPage]) {
              pageRefs.current[nextPage].scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          const nextTokens = pageTokensMap.current.get(nextPage);
          if (nextTokens) speakFromToken(null, nextTokens, nextPage);
          else waitingForPageRef.current = nextPage;
      } else {
          setIsPlaying(false);
          setActiveTokenId(null);
      }
  };

  const togglePlay = () => {
    if (isMarkingMode) return;
    if (isPlaying) {
        setIsPlaying(false);
        isPlayingRef.current = false;
        waitingForPageRef.current = null;
        synth.cancel();
    } else {
        setIsPlaying(true);
        isPlayingRef.current = true;
        const tokens = pageTokensMap.current.get(activePage) || currentTokens;
        speakFromToken(activeTokenId || (tokens[0] ? tokens[0].id : undefined), tokens, activePage); 
    }
  };

  return (
    <div className="app-layout" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {isDragging && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '24px', pointerEvents: 'none' }}>
            <div><Icons.Upload style={{width: 64, height: 64, marginBottom: 20}} /><p>Drop PDF to Open</p></div>
        </div>
      )}

      <main className="main-content">
        <div className="scroll-viewport" ref={viewportRef}>
            {!pdf ? (
                <div className="empty-placeholder">
                    <label className="upload-btn main-upload">
                        <Icons.Upload /> Open PDF File
                        <input type="file" accept="application/pdf" onChange={onFileChange} style={{display:'none'}} />
                    </label>
                    <p style={{marginTop: '20px', color: '#666', fontSize: '14px'}}>or drag and drop a file here</p>
                </div>
            ) : (
                <div className="pdf-stream">
                    {Array.from(new Array(numPages), (_, i) => i + 1).map(pageNum => (
                        <PDFPage 
                            key={pageNum}
                            pdfDoc={pdf}
                            pageNum={pageNum}
                            scale={scale} // Pass Dynamic Scale here
                            activeTokenId={activeTokenId}
                            onTokensParsed={handleTokenClick}
                            registerPageRef={registerPageRef}
                            notifyPageVisible={notifyPageVisible}
                            registerPageTokens={handlePageTokensRegistered}
                            isMarkingMode={isMarkingMode}
                            skipZones={skipZones}
                            onAddSkipZone={handleAddSkipZone}
                            onRemoveSkipZone={handleRemoveSkipZone}
                        />
                    ))}
                </div>
            )}
        </div>

        {pdf && (
            <div className="player-bar">
                {/* --- Left: Play Controls --- */}
                <div className="player-controls">
                    <button className="play-fab" onClick={togglePlay} disabled={isMarkingMode} style={{ opacity: isMarkingMode ? 0.5 : 1 }}>
                        {isPlaying ? <Icons.Pause /> : <Icons.Play />}
                    </button>
                    <div className="jump-group">
                        <span className="label">Pg</span>
                        <input 
                            type="number" min="1" max={numPages} value={jumpInput} 
                            onChange={(e) => setJumpInput(e.target.value)}
                            onKeyDown={handleJumpKey}
                            onFocus={() => setIsInputFocused(true)}
                            onBlur={() => setIsInputFocused(false)}
                            className="page-input"
                        />
                        <span className="label">/ {numPages}</span>
                    </div>
                </div>
                
                {/* --- Middle: Voice & Zoom --- */}
                <div className="center-controls" style={{display:'flex', gap:'15px', alignItems:'center'}}>
                    <div className="voice-group">
                        <Icons.Voice />
                        <select value={selectedVoiceURI} onChange={e => setSelectedVoiceURI(e.target.value)} className="voice-select">
                            {voices.map(v => (
                                <option key={v.voiceURI} value={v.voiceURI}>{v.name.slice(0, 20)} ({v.lang})</option>
                            ))}
                        </select>
                    </div>

                    {/* NEW ZOOM CONTROLS */}
                    <div className="zoom-group" style={{ display: 'flex', alignItems: 'center', background: '#f0f0f0', padding: '4px 8px', borderRadius: '8px' }}>
                        <button className="icon-btn-small" onClick={handleZoomOut} title="Zoom Out" style={{padding: '4px', cursor: 'pointer'}}>
                           <b>-</b>
                        </button>
                        
                        <div style={{position:'relative', margin: '0 8px'}}>
                            <input 
                                type="text"
                                value={zoomInput}
                                onChange={handleZoomInputChange}
                                onBlur={handleZoomInputBlur}
                                onKeyDown={handleZoomInputKeyDown}
                                style={{ width: '40px', textAlign: 'center', border: 'none', background: 'transparent', fontWeight: 600 }}
                            />
                            <span style={{fontSize: '10px', color: '#666'}}>%</span>
                        </div>

                        <button className="icon-btn-small" onClick={handleZoomIn} title="Zoom In" style={{padding: '4px', cursor: 'pointer'}}>
                            <b>+</b>
                        </button>

                        <div style={{width: '1px', height: '16px', background: '#ccc', margin: '0 8px'}}></div>

                        <button onClick={toggleFitMode} title="Toggle Fit" style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '12px', fontWeight: '600', color: '#444' }}>
                           {fitMode === 'width' ? 'Fit W' : fitMode === 'height' ? 'Fit H' : 'Fit'}
                        </button>
                    </div>
                </div>

                {/* --- Right: Tools & Speed --- */}
                <div className="right-controls" style={{display:'flex', gap:'10px', alignItems:'center'}}>
                    <button className={`icon-btn ${isMarkingMode ? 'active' : ''}`} onClick={() => { if (!isMarkingMode && isPlaying) togglePlay(); setIsMarkingMode(!isMarkingMode); }} title="Mark Skip Area">
                        <Icons.Crop />
                        <span style={{fontSize:'12px', marginLeft:'5px'}}>{isMarkingMode ? "Done" : "Skip Area"}</span>
                    </button>
                    <div className="speed-slider-group">
                        <span>Speed</span>
                        <input type="range" min="0.5" max="3.0" step="0.1" value={rate} onChange={e => setRate(Number(e.target.value))} />
                        <span className="speed-val">{rate.toFixed(1)}x</span>
                    </div>
                </div>
            </div>
        )}
      </main>
    </div>
  );
};

export default App;