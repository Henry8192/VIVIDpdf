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
  
  // Navigation
  const [numPages, setNumPages] = useState(0);
  const [activePage, setActivePage] = useState(1);
  const [jumpInput, setJumpInput] = useState("1");
  const [isInputFocused, setIsInputFocused] = useState(false);

  // Zoom / View
  const [scale, setScale] = useState(1.5);
  const [rotation, setRotation] = useState(0);
  const [zoomInput, setZoomInput] = useState("150"); 
  const [fitMode, setFitMode] = useState('custom'); 

  // TTS State
  const [voices, setVoices] = useState([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState("");
  const [activeTokenId, setActiveTokenId] = useState(null);

  // Skip / Zones
  const [isMarkingMode, setIsMarkingMode] = useState(false);
  const [skipZones, setSkipZones] = useState([]);
  
  // Debug
  const [debugImages, setDebugImages] = useState([]);

  // UI State
  const [showSettings, setShowSettings] = useState(false);

  // Refs
  const isPlayingRef = useRef(false); 
  const rateRef = useRef(1.0);
  const synth = window.speechSynthesis;
  const pageRefs = useRef({}); 
  const viewportRef = useRef(null); 
  
  const pageTokensMap = useRef(new Map());
  const waitingForPageRef = useRef(null);
  
  // Visual
  const [isLoading, setIsLoading] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { rateRef.current = rate; }, [rate]);

  // Sync Zoom Input
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

  // --- Zoom & Rotation ---
  const updateScale = (newScale) => {
      const clamped = Math.min(Math.max(newScale, 0.5), 5.0); 
      setScale(clamped);
      setFitMode('custom');
  };

  const handleZoomIn = () => updateScale(scale + 0.1);
  const handleZoomOut = () => updateScale(scale - 0.1);

  const handleZoomInputChange = (e) => setZoomInput(e.target.value);
  
  const handleZoomInputBlur = () => {
      const val = parseInt(zoomInput, 10);
      if (!isNaN(val)) updateScale(val / 100);
      else setZoomInput(Math.round(scale * 100).toString());
  };

  const handleZoomInputKeyDown = (e) => {
      if (e.key === 'Enter') e.target.blur();
  };

  const handleRotate = () => {
      setRotation(prev => (prev + 90) % 360);
  };

  const toggleFitMode = async () => {
    if (!pdf || !viewportRef.current) return;
    try {
        const page = await pdf.getPage(activePage);
        const unscaledViewport = page.getViewport({ scale: 1.0, rotation: (page.rotate + rotation) % 360 });
        const containerWidth = viewportRef.current.clientWidth;
        const containerHeight = viewportRef.current.clientHeight;
        const pad = 40; 
        
        if (fitMode === 'width') {
            const newScale = (containerHeight - pad) / unscaledViewport.height;
            setScale(newScale);
            setFitMode('height');
        } else {
            const newScale = (containerWidth - pad) / unscaledViewport.width;
            setScale(newScale);
            setFitMode('width');
        }
    } catch (err) {
        console.error("Error calculating fit:", err);
    }
  };

  // --- Core Logic ---
  const handleAddSkipZone = useCallback((zone) => {
      setSkipZones(prev => [...prev, zone]);
  }, []);

  const handleRemoveSkipZone = useCallback((id) => {
      setSkipZones(prev => prev.filter(z => z.id !== id));
  }, []);

  const handlePageTokensRegistered = useCallback((pageNum, tokens) => {
    pageTokensMap.current.set(pageNum, tokens);

    // --- FIX: Cross-Page Hyphenation Merge ---
    const tryMergeNeighbors = (p1, p2) => {
        const t1 = pageTokensMap.current.get(p1);
        const t2 = pageTokensMap.current.get(p2);
        if (!t1 || !t2 || t1.length === 0 || t2.length === 0) return;

        const last = t1[t1.length - 1];
        const first = t2[0];

        // If already linked, skip
        if (first.linkedTo === last.id) return;

        // Check for hyphen at end of previous page
        if (/[-\u2010\u2011\u00AD]$/.test(last.text)) {
            // Remove hyphen from spoken text and append next word
            const cleanPrefix = last.text.replace(/[-\u2010\u2011\u00AD]$/, '');
            last.spokenText = cleanPrefix + first.text;
            
            // Silence the second part so it doesn't trigger a separate read
            first.spokenText = "";
            
            // Link them for highlighting: when 'last' is active, 'first' should also highlight
            first.linkedTo = last.id;
        }
    };

    // Check boundary with previous page
    tryMergeNeighbors(pageNum - 1, pageNum);
    // Check boundary with next page
    tryMergeNeighbors(pageNum, pageNum + 1);

    if (waitingForPageRef.current === pageNum && isPlayingRef.current) {
        waitingForPageRef.current = null;
        scheduleNextBatch(pageNum, []);
    }
  }, []);

  const loadFromBlob = async (blob) => {
    setIsLoading(true); 
    try {
        if (blob.name) { document.title = blob.name;}
        const data = await blob.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data });
        const pdfDoc = await loadingTask.promise;
        
        setPdf(pdfDoc);
        setNumPages(pdfDoc.numPages);
        setActivePage(1);
        setJumpInput("1");
        
        setScale(1.5);
        setRotation(0);
        setFitMode('custom');

        setActiveTokenId(null);
        setIsPlaying(false);
        pageTokensMap.current.clear();
        waitingForPageRef.current = null;
        setDebugImages([]);
        
        setSkipZones([]);
        synth.cancel();
    } catch (error) {
        console.error("Error loading PDF:", error);
        alert("Failed to load PDF. Please ensure it is a valid file.");
    } finally {
        setIsLoading(false); 
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

  // Note: Updated to store the Component Ref, not just the DIV
  const registerPageRef = (num, ref) => { pageRefs.current[num] = ref; };
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
      synth.cancel();
      setIsPlaying(true);
      isPlayingRef.current = true;
      waitingForPageRef.current = null;
      
      let startIndex = 0;
      if (clickedTokenId) {
          startIndex = pageTokens.findIndex(t => t.id === clickedTokenId);
          if (startIndex === -1) startIndex = 0;
      }
      const tokensToPlay = pageTokens.slice(startIndex);
      
      scheduleNextBatch(pageNum, tokensToPlay, true);
  }, [voices, selectedVoiceURI, rate]);

  // --- TTS Engine ---

  const scheduleNextBatch = (startPageNum, carryOverTokens, isFirstBatch = false) => {
    if (!isPlayingRef.current) return;

    let pool = [...carryOverTokens];
    
    if (pool.length === 0) {
        const pageTokens = pageTokensMap.current.get(startPageNum);
        if (!pageTokens) {
            waitingForPageRef.current = startPageNum;
            setActivePage(startPageNum);
             if (pageRefs.current[startPageNum]) {
                pageRefs.current[startPageNum].scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            return;
        }
        pool = [...pageTokens];
    }

    const nextPageNum = startPageNum + 1;
    const nextPageTokens = pageTokensMap.current.get(nextPageNum);
    let hasNextPage = false;

    if (nextPageTokens && nextPageTokens.length > 0) {
        pool = [...pool, ...nextPageTokens];
        hasNextPage = true;
    }

    let endIndex = pool.length;
    let nextLeftovers = [];
    
    if (hasNextPage) {
        let safetyFound = false;
        for (let i = pool.length - 1; i > 0; i--) {
             const txt = pool[i].spokenText.trim();
             // Skip empty texts (silenced hyphen parts) when checking for punctuation
             if (!txt) continue;

             if (/[.!?]["']?$/.test(txt)) {
                 endIndex = i + 1;
                 safetyFound = true;
                 break;
             }
        }
        if (safetyFound && endIndex < pool.length) {
            nextLeftovers = pool.slice(endIndex);
            pool = pool.slice(0, endIndex);
        }
    }

    let script = "";
    const map = [];
    pool.forEach(token => {
        const text = token.spokenText;
        if (!text) return; // Skip silent tokens (merged parts) in script

        const start = script.length;
        script += text + " ";
        const end = start + text.length;
        map.push({ start, end, token });
    });

    if (!script.trim()) {
        if (startPageNum < numPages) {
            scheduleNextBatch(nextPageNum, []);
        } else {
            setIsPlaying(false);
        }
        return;
    }

    const utter = new SpeechSynthesisUtterance(script);
    utter.rate = rateRef.current;
    const targetVoice = voices.find(v => v.voiceURI === selectedVoiceURI);
    if (targetVoice) { utter.voice = targetVoice; utter.lang = targetVoice.lang; }
    
    utter.audioMap = map;
    utter.nextBatchInfo = {
        pageNum: hasNextPage ? nextPageNum : startPageNum + 1,
        leftovers: nextLeftovers
    };
    utter.hasQueuedNext = false; 

    utter.onboundary = (event) => {
        if (!isPlayingRef.current) { synth.cancel(); return; }
        
        const currentMap = event.target.audioMap;
        if (!currentMap) return;

        const currentIdx = event.charIndex;
        const entry = currentMap.find(m => currentIdx >= m.start && currentIdx < m.end);
        
        if (entry) {
            setActiveTokenId(entry.token.id);
            if (entry.token.pageNum !== activePage) {
                setActivePage(entry.token.pageNum);
                if (pageRefs.current[entry.token.pageNum]) {
                    pageRefs.current[entry.token.pageNum].scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
        }
    };

    utter.onstart = (event) => {
        if (!isPlayingRef.current) return;
        const info = event.target.nextBatchInfo;
        
        if (info && !event.target.hasQueuedNext && info.pageNum <= numPages) {
             if (info.leftovers.length > 0 || pageTokensMap.current.has(info.pageNum)) {
                 event.target.hasQueuedNext = true;
                 scheduleNextBatch(info.pageNum, info.leftovers);
             }
        }
    };

    utter.onend = (event) => {
        if (!isPlayingRef.current) return;
        if (!event.target.hasQueuedNext) {
            const info = event.target.nextBatchInfo;
            if (info && info.pageNum <= numPages) {
                 scheduleNextBatch(info.pageNum, info.leftovers);
            } else {
                setIsPlaying(false);
                setActiveTokenId(null);
            }
        }
    };

    utter.onerror = () => {
        if (isPlayingRef.current) setIsPlaying(false);
    };

    synth.speak(utter);
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
        const tokens = pageTokensMap.current.get(activePage) || [];
        let startTokens = [];
        if (activeTokenId && tokens.length > 0) {
            const idx = tokens.findIndex(t => t.id === activeTokenId);
            startTokens = idx >= 0 ? tokens.slice(idx) : tokens;
        } else {
            startTokens = tokens;
        }
        
        scheduleNextBatch(activePage, startTokens, true); 
    }
  };

  const handleDebugExtract = async () => {
      const pageRef = pageRefs.current[activePage];
      if (pageRef && pageRef.generateDebugImages) {
          const images = await pageRef.generateDebugImages();
          setDebugImages(images);
          setShowSettings(false); // Close menu on action
      } else {
          alert("Debug: Page not ready or loaded.");
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
            {isLoading && (
                <div className="loading-overlay">
                    <div className="spinner"></div>
                    <p>Processing Document...</p>
                </div>
            )}
            {!pdf ? (
                <div className="empty-placeholder">
                    <label className="upload-btn main-upload">
                        <Icons.Upload /> Open PDF File
                        <input type="file" accept="application/pdf" onChange={onFileChange} style={{display:'none'}} />
                    </label>
                    <p style={{marginTop: '20px', color: '#666', fontSize: '14px'}}>or drag and drop a file here</p>
                </div>
            ) : (
                <>
                    <div className={`pdf-stream ${darkMode ? 'dark-mode' : ''}`}>
                        {Array.from(new Array(numPages), (_, i) => i + 1).map(pageNum => (
                            <PDFPage 
                                key={pageNum}
                                ref={(r) => registerPageRef(pageNum, r)}
                                pdfDoc={pdf}
                                pageNum={pageNum}
                                scale={scale}
                                rotation={rotation}
                                activeTokenId={activeTokenId}
                                onTokensParsed={handleTokenClick}
                                notifyPageVisible={notifyPageVisible}
                                registerPageTokens={handlePageTokensRegistered}
                                isMarkingMode={isMarkingMode}
                                skipZones={skipZones}
                                onAddSkipZone={handleAddSkipZone}
                                onRemoveSkipZone={handleRemoveSkipZone}
                            />
                        ))}
                    </div>
                    {debugImages.length > 0 && (
                        <div className="debug-panel" style={{ padding: '20px', background: '#f5f5f5', borderTop: '1px solid #ccc' }}>
                            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 15}}>
                                <h3>Debug Extraction Output ({debugImages.length})</h3>
                                <button className="icon-btn" onClick={() => setDebugImages([])}><Icons.Close/> Clear</button>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                                {debugImages.map((item, idx) => (
                                    <div key={idx} style={{ background: 'white', padding: '10px', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }}>
                                        <div style={{ marginBottom: '5px', fontSize: '12px', color: '#555', fontFamily: 'monospace' }}>
                                            {item.text}
                                        </div>
                                        <img src={item.img} alt={`Sentence ${idx}`} style={{ maxWidth: '100%', border: '1px solid #ddd' }} />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>

        {pdf && (
            <div className="player-bar-container">
                <div className="player-bar">
                    {/* LEFT: Playback & Navigation */}
                    <div className="section-left">
                        {/* Changed to standard icon-btn for unified look */}
                        <button className="icon-btn" onClick={togglePlay} disabled={isMarkingMode} style={{ opacity: isMarkingMode ? 0.5 : 1 }} title={isPlaying ? "Pause" : "Play"}>
                            {isPlaying ? <Icons.Pause /> : <Icons.Play />}
                        </button>
                        <div className="divider-vertical"></div>
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
                    
                    {/* CENTER: View Controls */}
                    <div className="section-center">
                        <div className="zoom-group">
                            <button className="icon-btn-ghost" onClick={handleZoomOut} title="Zoom Out">-</button>
                            <input 
                                className="zoom-input"
                                type="text"
                                value={zoomInput}
                                onChange={handleZoomInputChange}
                                onBlur={handleZoomInputBlur}
                                onKeyDown={handleZoomInputKeyDown}
                            />
                            <span className="zoom-unit">%</span>
                            <button className="icon-btn-ghost" onClick={handleZoomIn} title="Zoom In">+</button>
                        </div>

                        <div className="divider-vertical small"></div>

                        <button className="text-btn" onClick={toggleFitMode} title="Toggle Fit">
                           {fitMode === 'width' ? 'Fit W' : fitMode === 'height' ? 'Fit H' : 'Fit'}
                        </button>

                         <div className="divider-vertical small"></div>
                        
                        {/* Changed to standard icon-btn to fix visibility issues */}
                        <button className="icon-btn" onClick={handleRotate} title="Rotate 90°">
                            <Icons.Rotate style={{ width: '20px', height: '20px' }} />
                        </button>
                    </div>

                    {/* RIGHT: Tools & Settings */}
                    <div className="section-right">
                        <button 
                            className={`icon-btn ${isMarkingMode ? 'active-danger' : ''}`} 
                            onClick={() => { if (!isMarkingMode && isPlaying) togglePlay(); setIsMarkingMode(!isMarkingMode); }} 
                            title={isMarkingMode ? "Finish Marking" : "Mark Skip Area"}
                        >
                            <Icons.Crop />
                        </button>

                        <button 
                            className={`icon-btn ${darkMode ? 'active' : ''}`} 
                            onClick={() => setDarkMode(!darkMode)} 
                            title="Toggle Dark Mode"
                        >
                            <Icons.Moon /> 
                        </button>

                        <div style={{ position: 'relative' }}>
                            <button 
                                className={`icon-btn ${showSettings ? 'active' : ''}`} 
                                onClick={() => setShowSettings(!showSettings)} 
                                title="Settings"
                            >
                                <Icons.Settings />
                            </button>

                            {showSettings && (
                                <div className="settings-popup">
                                    <div className="settings-header">Reading Settings</div>
                                    
                                    <div className="setting-item">
                                        <label><Icons.Voice /> Voice</label>
                                        <select value={selectedVoiceURI} onChange={e => setSelectedVoiceURI(e.target.value)} className="voice-select">
                                            {voices.map(v => (
                                                <option key={v.voiceURI} value={v.voiceURI}>{v.name.slice(0, 24)}...</option>
                                            ))}
                                        </select>
                                    </div>

                                    <div className="setting-item">
                                        <div className="label-row">
                                            <label>Speed</label>
                                            <span className="value-badge">{rate.toFixed(1)}x</span>
                                        </div>
                                        <input 
                                            type="range" 
                                            className="styled-slider"
                                            min="0.5" max="3.0" step="0.1" 
                                            value={rate} 
                                            onChange={e => setRate(Number(e.target.value))} 
                                        />
                                        <div className="slider-labels">
                                            <span>0.5x</span>
                                            <span>3.0x</span>
                                        </div>
                                    </div>
                                    
                                    <div className="setting-divider"></div>
                                    
                                    <button onClick={handleDebugExtract} className="menu-btn" title="Generate Sentence Images">
                                        Sentence Segmentation Preview
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        )}
      </main>
    </div>
  );
};

export default App;