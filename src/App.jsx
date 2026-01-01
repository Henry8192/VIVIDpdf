import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Point this to your specific worker version
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;

// --- Icon Components ---
const Icons = {
  Upload: () => <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>,
  Play: () => <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>,
  Pause: () => <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>,
  Voice: () => <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>,
  // NEW ICONS
  Crop: () => <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"></path><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"></path></svg>,
  Close: () => <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3"  viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>,
};

// --- Helper: Check Intersection ---
const isTokenInZone = (tokenRect, zoneRect) => {
  // Returns true if rectangles overlap
  return !(
    tokenRect.right < zoneRect.left ||
    tokenRect.left > zoneRect.right ||
    tokenRect.bottom < zoneRect.top ||
    tokenRect.top > zoneRect.bottom
  );
};

// --- PDF Page Component ---
const PDFPage = ({ 
  pdfDoc, 
  pageNum, 
  scale, 
  onTokensParsed, 
  activeTokenId, 
  registerPageRef,
  notifyPageVisible,
  registerPageTokens,
  // NEW PROPS
  isMarkingMode,
  skipZones,
  onAddSkipZone,
  onRemoveSkipZone
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [pageDimensions, setPageDimensions] = useState(null); 
  const [hoveredTokenId, setHoveredTokenId] = useState(null);
  
  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [currentRect, setCurrentRect] = useState(null);
    
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const textLayerRef = useRef(null);
  const pageTokensRef = useRef([]);
  const spanMapRef = useRef(new Map());

  // --- Scroll Visibility Observer ---
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) notifyPageVisible(pageNum);
      },
      { rootMargin: '200px', threshold: 0.5 } 
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [pageNum, notifyPageVisible]);

  // --- Rendering Logic ---
  useEffect(() => {
    if (!isVisible || !pdfDoc) return;

    let isCancelled = false;

    const render = async () => {
      try {
        const page = await pdfDoc.getPage(pageNum);
        const pixelRatio = window.devicePixelRatio || 1;
        
        // Base viewport
        const viewport = page.getViewport({ scale: scale });
        const renderViewport = page.getViewport({ scale: scale * pixelRatio });

        setPageDimensions({ width: viewport.width, height: viewport.height });

        if (containerRef.current) containerRef.current.style.setProperty('--scale-factor', scale);

        // Render Canvas
        if (canvasRef.current) {
            const ctx = canvasRef.current.getContext('2d');
            canvasRef.current.width = renderViewport.width;
            canvasRef.current.height = renderViewport.height;
            canvasRef.current.style.width = `${viewport.width}px`;
            canvasRef.current.style.height = `${viewport.height}px`;
            
            // Only render canvas if we haven't already to save resources (optional optimization)
            // For now, we render every time to ensure clarity
            await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
        }

        if (isCancelled) return;

        // Render Text Layer
        if (textLayerRef.current) {
            textLayerRef.current.innerHTML = '';
            textLayerRef.current.style.width = `${viewport.width}px`;
            textLayerRef.current.style.height = `${viewport.height}px`;

            const textContent = await page.getTextContent();
            await pdfjsLib.renderTextLayer({
                textContent,
                container: textLayerRef.current,
                viewport,
                enhanceTextSelection: true
            }).promise;

            // --- TOKEN GENERATION WITH FILTERING ---
            const spans = Array.from(textLayerRef.current.querySelectorAll('span'));
            let localTokens = [];
            let localIdCounter = 0;

            spans.forEach(span => {
                const text = span.textContent;
                if (!text.trim()) return;

                // 1. Get Span Geometry for Filtering
                const spanLeft = span.offsetLeft;
                const spanTop = span.offsetTop;
                const spanWidth = span.offsetWidth;
                const spanHeight = span.offsetHeight;

                // 2. Check overlap with ANY skip zone
                // Convert SkipZones (0-1) to Pixels for this page
                const isSkipped = skipZones.some(zone => {
                    const zonePx = {
                        left: zone.x * viewport.width,
                        top: zone.y * viewport.height,
                        right: (zone.x + zone.w) * viewport.width,
                        bottom: (zone.y + zone.h) * viewport.height
                    };
                    const spanRect = {
                        left: spanLeft,
                        top: spanTop,
                        right: spanLeft + spanWidth,
                        bottom: spanTop + spanHeight
                    };
                    return isTokenInZone(spanRect, zonePx);
                });

                if (isSkipped) {
                    // Visual feedback: grey out skipped text
                    span.style.opacity = '0.2';
                    span.style.textDecoration = 'line-through';
                    return; // Skip adding to tokens
                }

                const regex = /\S+/g;
                let match;
                const spanTokens = [];
                while ((match = regex.exec(text)) !== null) {
                    const token = {
                        id: `p${pageNum}_t${localIdCounter++}`,
                        pageNum: pageNum,
                        text: match[0],
                        spokenText: match[0],
                        spanElement: span,
                        startOffset: match.index,
                        endOffset: regex.lastIndex
                    };
                    localTokens.push(token);
                    spanTokens.push(token);
                }
                spanMapRef.current.set(span, spanTokens);
            });
            
            pageTokensRef.current = localTokens;
            registerPageTokens(pageNum, localTokens);
        }
      } catch (err) {
        console.error(`Error rendering page ${pageNum}`, err);
      }
    };

    render();
    return () => { isCancelled = true; };
    
    // Add skipZones to dependency so we re-parse tokens when zones change
  }, [isVisible, pdfDoc, pageNum, scale, skipZones, registerPageTokens]);

  // --- Drawing Logic ---
  const handleMouseDown = (e) => {
    if (!isMarkingMode) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setDrawStart({ x, y });
    setCurrentRect({ x, y, w: 0, h: 0 });
    setIsDrawing(true);
  };

  const handleMouseMoveDrawing = (e) => {
    if (!isDrawing || !isMarkingMode) return;
    const rect = containerRef.current.getBoundingClientRect();
    const curX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const curY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));

    const x = Math.min(drawStart.x, curX);
    const y = Math.min(drawStart.y, curY);
    const w = Math.abs(curX - drawStart.x);
    const h = Math.abs(curY - drawStart.y);

    setCurrentRect({ x, y, w, h });
  };

  const handleMouseUp = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    
    if (currentRect && currentRect.w > 5 && currentRect.h > 5 && pageDimensions) {
        // Normalize coordinates (0 to 1)
        const normZone = {
            id: Date.now(),
            x: currentRect.x / pageDimensions.width,
            y: currentRect.y / pageDimensions.height,
            w: currentRect.w / pageDimensions.width,
            h: currentRect.h / pageDimensions.height
        };
        onAddSkipZone(normZone);
    }
    setCurrentRect(null);
  };

  // --- Interaction Logic ---
  const getTokenFromEvent = (e) => {
    if (isMarkingMode) return null; // Disable reading clicks when marking
    let range;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(e.clientX, e.clientY);
    else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.setEnd(pos.offsetNode, pos.offset);
    }
    
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null;

    const targetSpan = range.startContainer.parentElement;
    const offset = range.startOffset;
    const tokensInSpan = spanMapRef.current.get(targetSpan);

    if (tokensInSpan) {
        return tokensInSpan.find(t => offset >= t.startOffset && offset <= t.endOffset);
    }
    return null;
  };

  const handlePageClick = (e) => {
    if (isMarkingMode) return;
    const clickedToken = getTokenFromEvent(e);
    if (clickedToken) {
        onTokensParsed(pageTokensRef.current, clickedToken.id, pageNum); 
    }
  };

  const handleMouseMove = (e) => {
    if (isMarkingMode) {
        handleMouseMoveDrawing(e);
        return;
    }
    const hoveredToken = getTokenFromEvent(e);
    if (hoveredToken) {
        if (hoveredToken.id !== hoveredTokenId) setHoveredTokenId(hoveredToken.id);
    } else {
        if (hoveredTokenId !== null) setHoveredTokenId(null);
    }
  };

  // --- Style Calculations ---
  const getHighlightStyle = useCallback((tokenId) => {
    if (!tokenId || !pageTokensRef.current.length || !containerRef.current) return null;
    const token = pageTokensRef.current.find(t => t.id === tokenId);
    if (!token) return null;

    try {
        const range = document.createRange();
        range.setStart(token.spanElement.firstChild, token.startOffset);
        range.setEnd(token.spanElement.firstChild, token.endOffset);
        const rect = range.getBoundingClientRect();
        const containerRect = containerRef.current.getBoundingClientRect();

        return {
            left: rect.left - containerRect.left,
            top: rect.top - containerRect.top,
            width: rect.width,
            height: rect.height
        };
    } catch (e) { return null; }
  }, []);

  const activeStyle = useMemo(() => getHighlightStyle(activeTokenId), [activeTokenId, getHighlightStyle]);
  const hoverStyle = useMemo(() => getHighlightStyle(hoveredTokenId), [hoveredTokenId, getHighlightStyle]);

  return (
    <div 
      ref={(el) => { containerRef.current = el; registerPageRef(pageNum, el); }} 
      className="pdf-page-container" 
      style={{ 
        width: pageDimensions ? pageDimensions.width : '600px',
        height: pageDimensions ? pageDimensions.height : '800px',
        marginBottom: '20px',
        position: 'relative',
        backgroundColor: 'white',
        boxShadow: '0 2px 5px rgba(0,0,0,0.1)',
        cursor: isMarkingMode ? 'crosshair' : 'default', // cursor change
        userSelect: isMarkingMode ? 'none' : 'auto' // prevent text select while drawing
      }}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
    >
      {isVisible && (
        <>
            <canvas ref={canvasRef} style={{ display: 'block', pointerEvents: 'none' }} />
            <div 
                ref={textLayerRef} 
                className="textLayer" 
                onClick={handlePageClick}
                onMouseLeave={() => setHoveredTokenId(null)}
                style={{ pointerEvents: isMarkingMode ? 'none' : 'auto' }} // Pass click through to container for drawing
            />
            {activeStyle && !isMarkingMode && <div className="highlight-box" style={activeStyle} />}
            {hoverStyle && !isMarkingMode && <div className="hover-box" style={hoverStyle} />}

            {/* RENDER SKIP ZONES */}
            {pageDimensions && skipZones.map(zone => (
                <div 
                    key={zone.id}
                    className="skip-zone-overlay"
                    style={{
                        left: zone.x * pageDimensions.width,
                        top: zone.y * pageDimensions.height,
                        width: zone.w * pageDimensions.width,
                        height: zone.h * pageDimensions.height,
                    }}
                >
                  {isMarkingMode && (
                      <button 
                          className="delete-zone-btn"
                          onClick={(e) => { e.stopPropagation(); onRemoveSkipZone(zone.id); }}
                          title="Remove Skip Zone"
                      >
                          <Icons.Close />
                      </button>
                  )}
                </div>
            ))}

            {/* RENDER DRAWING PREVIEW */}
            {isDrawing && currentRect && (
                <div 
                    className="skip-zone-drawing"
                    style={{
                        left: currentRect.x,
                        top: currentRect.y,
                        width: currentRect.w,
                        height: currentRect.h
                    }}
                />
            )}
        </>
      )}
      {!isVisible && (
          <div className="loading-placeholder"><span>Page {pageNum}</span></div>
      )}
    </div>
  );
};

// --- Main App Component ---
const App = () => {
  const [pdf, setPdf] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [rate, setRate] = useState(1.0);
  
  // Navigation State
  const [numPages, setNumPages] = useState(0);
  const [activePage, setActivePage] = useState(1);
  const [jumpInput, setJumpInput] = useState("1");
  const [isInputFocused, setIsInputFocused] = useState(false);

  // TTS State
  const [voices, setVoices] = useState([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState("");
  const [currentTokens, setCurrentTokens] = useState([]);
  const [activeTokenId, setActiveTokenId] = useState(null);

  // NEW: Skip State
  const [isMarkingMode, setIsMarkingMode] = useState(false);
  const [skipZones, setSkipZones] = useState([]); // Array of normalized rects {id, x, y, w, h}

  // Refs
  const isPlayingRef = useRef(false); 
  const rateRef = useRef(1.0);
  const audioMapRef = useRef([]); 
  const isSwitchingRef = useRef(false);
  const synth = window.speechSynthesis;
  const pageRefs = useRef({}); 
  
  const pageTokensMap = useRef(new Map());
  const waitingForPageRef = useRef(null);

  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { rateRef.current = rate; }, [rate]);

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

  // Handle adding a new zone
  const handleAddSkipZone = useCallback((zone) => {
      setSkipZones(prev => [...prev, zone]);
  }, []);

  // Handle removing a zone
  const handleRemoveSkipZone = useCallback((id) => {
      setSkipZones(prev => prev.filter(z => z.id !== id));
  }, []);

  const handlePageTokensRegistered = useCallback((pageNum, tokens) => {
    pageTokensMap.current.set(pageNum, tokens);
    
    // If we are waiting for this page to start reading
    if (waitingForPageRef.current === pageNum && isPlayingRef.current) {
        waitingForPageRef.current = null;
        speakFromToken(null, tokens, pageNum);
    }
  }, []);

  const onFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const data = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdfDoc = await loadingTask.promise;
    
    setPdf(pdfDoc);
    setNumPages(pdfDoc.numPages);
    setActivePage(1);
    setJumpInput("1");
    
    setCurrentTokens([]);
    setActiveTokenId(null);
    setIsPlaying(false);
    pageTokensMap.current.clear();
    waitingForPageRef.current = null;
    
    // Clear old skip zones on new file
    setSkipZones([]);
    synth.cancel();
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
      // If marking mode is on, we generally disable reading start to avoid conflict, 
      // but logic is handled in PDFPage onClick.
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
        // SAFETY CHECK: Ensure token wasn't filtered out (though filtered ones shouldn't be in tokensToRead)
        if (!token) continue;

        const start = script.length;
        const textToRead = token.spokenText;
        const end = start + textToRead.length;
        map.push({ start, end, token });
        script += textToRead + " "; 
    }

    audioMapRef.current = map;
    
    if (!script.trim()) {
        handlePageEnd(pageNum);
        return;
    }

    const utter = new SpeechSynthesisUtterance(script);
    utter.rate = rateRef.current;
    
    const targetVoice = voices.find(v => v.voiceURI === selectedVoiceURI);
    if (targetVoice) {
        utter.voice = targetVoice;
        utter.lang = targetVoice.lang;
    }

    utter.onboundary = (event) => {
        if (!isPlayingRef.current) { synth.cancel(); return; }
        
        const currentIdx = event.charIndex;
        const entry = audioMapRef.current.find(m => currentIdx >= m.start && currentIdx < m.end);
        
        if (entry) {
            setActiveTokenId(entry.token.id);
        }
    };

    utter.onend = () => {
        if (isSwitchingRef.current) return;
        if (!isPlayingRef.current) return;
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
          if (nextTokens) {
              speakFromToken(null, nextTokens, nextPage);
          } else {
              waitingForPageRef.current = nextPage;
          }
      } else {
          setIsPlaying(false);
          setActiveTokenId(null);
      }
  };

  const togglePlay = () => {
    if (isMarkingMode) return; // Disable play toggle during marking
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
    <div className="app-layout">
      <main className="main-content">
        <div className="scroll-viewport">
            {!pdf ? (
                <div className="empty-placeholder">
                    <label className="upload-btn main-upload">
                        <Icons.Upload /> Open PDF File
                        <input type="file" accept="application/pdf" onChange={onFileChange} style={{display:'none'}} />
                    </label>
                </div>
            ) : (
                <div className="pdf-stream">
                    {Array.from(new Array(numPages), (_, i) => i + 1).map(pageNum => (
                        <PDFPage 
                            key={pageNum}
                            pdfDoc={pdf}
                            pageNum={pageNum}
                            scale={1.5}
                            activeTokenId={activeTokenId}
                            onTokensParsed={handleTokenClick}
                            registerPageRef={registerPageRef}
                            notifyPageVisible={notifyPageVisible}
                            registerPageTokens={handlePageTokensRegistered}
                            // Pass Skip Props
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
                <div className="player-controls">
                    <button 
                        className="play-fab" 
                        onClick={togglePlay}
                        disabled={isMarkingMode}
                        style={{ opacity: isMarkingMode ? 0.5 : 1 }}
                    >
                        {isPlaying ? <Icons.Pause /> : <Icons.Play />}
                    </button>
                    
                    <div className="jump-group">
                        <span className="label">Pg</span>
                        <input 
                            type="number" 
                            min="1" 
                            max={numPages} 
                            value={jumpInput} 
                            onChange={(e) => setJumpInput(e.target.value)}
                            onKeyDown={handleJumpKey}
                            onFocus={() => setIsInputFocused(true)}
                            onBlur={() => setIsInputFocused(false)}
                            className="page-input"
                        />
                        <span className="label">/ {numPages}</span>
                    </div>
                </div>
                
                <div className="voice-group">
                    <Icons.Voice />
                    <select value={selectedVoiceURI} onChange={e => setSelectedVoiceURI(e.target.value)} className="voice-select">
                        {voices.map(v => (
                            <option key={v.voiceURI} value={v.voiceURI}>
                                {v.name.slice(0, 20)} ({v.lang})
                            </option>
                        ))}
                    </select>
                </div>

                {/* NEW SKIP CONTROL */}
                <button 
                    className={`icon-btn ${isMarkingMode ? 'active' : ''}`}
                    onClick={() => {
                        // Stop playing if entering mark mode
                        if (!isMarkingMode && isPlaying) togglePlay(); 
                        setIsMarkingMode(!isMarkingMode);
                    }}
                    title="Mark Skip Area"
                >
                    <Icons.Crop />
                    <span style={{fontSize:'12px', marginLeft:'5px'}}>
                        {isMarkingMode ? "Done" : "Skip Area"}
                    </span>
                </button>

                <div className="speed-slider-group">
                    <span>Speed</span>
                    <input type="range" min="0.5" max="3.0" step="0.1" value={rate} onChange={e => setRate(Number(e.target.value))} />
                    <span className="speed-val">{rate.toFixed(1)}x</span>
                </div>
            </div>
        )}
      </main>

      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f0f11; color: #e4e4e7; height: 100vh; overflow: hidden; }
        .app-layout { display: flex; height: 100vh; width: 100vw; }
        
        .main-content { flex: 1; display: flex; flex-direction: column; position: relative; background: #202023; }
        
        .scroll-viewport { flex: 1; overflow-y: auto; display: flex; justify-content: center; padding: 40px 0 120px 0; scroll-behavior: smooth; }
        .pdf-stream { display: flex; flex-direction: column; align-items: center; gap: 20px; width: 100%; }
        
        .pdf-page-container { transition: box-shadow 0.2s; position: relative; }
        canvas { display: block; }
        
        .textLayer { position: absolute; top: 0; left: 0; right: 0; bottom: 0; overflow: hidden; opacity: 1; line-height: 1.0; transform-origin: 0 0; z-index: 2; }
        .textLayer span { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; }
        
        .highlight-box { position: absolute; background-color: rgba(99, 102, 241, 0.3); border: 2px solid #6366f1; border-radius: 2px; pointer-events: none; z-index: 10; mix-blend-mode: multiply; transition: all 0.05s ease; }
        
        .hover-box { position: absolute; background-color: rgba(99, 102, 241, 0.2); border-radius: 2px; pointer-events: none; z-index: 5; mix-blend-mode: multiply; }
        
        /* NEW SKIP STYLES */
        .skip-zone-overlay { position: absolute; background-color: rgba(239, 68, 68, 0.15); border: 2px dashed rgba(239, 68, 68, 0.8); z-index: 20; pointer-events: none; }
        .skip-zone-drawing { position: absolute; background-color: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.8); z-index: 20; pointer-events: none; }
        
        .delete-zone-btn { 
            position: absolute; 
            top: -10px; 
            right: -10px; 
            width: 22px; 
            height: 22px; 
            border-radius: 50%; 
            background: #ef4444; 
            color: white; 
            border: 2px solid #fff; /* White border makes it pop */
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            cursor: pointer; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            padding: 0;
            pointer-events: auto; 
            transition: transform 0.1s ease;
        }

        .delete-zone-btn:hover { 
            background: #dc2626; 
            transform: scale(1.1);
        }
        .loading-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: #27272a; color: #52525b; border: 1px dashed #3f3f46; }

        .empty-placeholder { display:flex; flex-direction:column; align-items:center; margin-top: 30vh; color: #555; gap: 20px; }
        .empty-placeholder h3 { font-weight: 400; font-size: 24px; color: #71717a; margin: 0; }

        .upload-btn { display: flex; align-items: center; justify-content: center; gap: 8px; background: #27272a; color: #e4e4e7; padding: 10px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 14px; border: 1px solid #3f3f46; transition: all 0.2s; }
        .upload-btn:hover { background: #3f3f46; border-color: #6366f1; }
        .upload-btn.main-upload { background: #6366f1; color: white; border: none; padding: 12px 24px; font-size: 16px; }

        .player-bar { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); width: 800px; background: rgba(39, 39, 42, 0.95); border: 1px solid #3f3f46; border-radius: 16px; padding: 12px 24px; display: flex; align-items: center; gap: 20px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); z-index: 100; backdrop-filter: blur(10px); }
        .player-controls { display: flex; align-items: center; gap: 16px; flex-shrink: 0; }
        .play-fab { width: 40px; height: 40px; border-radius: 50%; background: #fff; color: #000; border: none; cursor: pointer; display: grid; place-items: center; }
        .play-fab:disabled { cursor: not-allowed; background: #555; }

        .jump-group { display: flex; align-items: center; gap: 5px; background: #18181b; padding: 4px 12px; border-radius: 6px; border: 1px solid #3f3f46; height: 32px; }
        .jump-group .label { font-size: 12px; color: #71717a; white-space: nowrap; }
        .page-input { width: 32px; background: transparent; border: none; color: #fff; text-align: center; font-size: 13px; outline: none; font-weight: 600; }
        .page-input:focus { color: #6366f1; }
        .page-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

        .voice-group { display: flex; align-items: center; gap: 8px; flex: 1; color: #a1a1aa; min-width: 0; }
        .voice-select { flex: 1; background: #27272a; color: #e4e4e7; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px; font-size: 12px; outline: none; cursor: pointer; width: 100%; }
        
        .icon-btn { display: flex; align-items: center; background: transparent; color: #a1a1aa; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px 10px; cursor: pointer; transition: all 0.2s; }
        .icon-btn:hover { background: #3f3f46; color: #fff; }
        .icon-btn.active { background: #fee2e2; color: #ef4444; border-color: #fca5a5; }

        .speed-slider-group { display: flex; align-items: center; gap: 10px; color: #fff; font-size: 12px; flex-shrink: 0; }
        input[type=range] { width: 80px; accent-color: #6366f1; }
        .speed-val { width: 30px; text-align: right; }
        
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #18181b; }
        ::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 4px; }
      `}</style>
    </div>
  );
};

export default App;