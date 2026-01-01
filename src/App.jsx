import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;

// --- Icon Components ---
const Icons = {
  Upload: () => <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>,
  Play: () => <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>,
  Pause: () => <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>,
  Voice: () => <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
};

// --- PDF Page Component ---
const PDFPage = ({ 
  pdfDoc, 
  pageNum, 
  scale, 
  onTokensParsed, 
  activeTokenId, 
  registerPageRef,
  notifyPageVisible // New prop to sync scroll state
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [isRendered, setIsRendered] = useState(false);
  const [pageDimensions, setPageDimensions] = useState(null); 
   
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const textLayerRef = useRef(null);
  const pageTokensRef = useRef([]);
  const spanMapRef = useRef(new Map());

  // --- Scroll Visibility Observer (Sync Page -> Input) ---
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Update visibility for rendering
        if (entry.isIntersecting) {
            setIsVisible(true);
        }
        // Notify parent if this page is the primary one in view
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            notifyPageVisible(pageNum);
        }
      },
      { 
          rootMargin: '200px', // Pre-load margin
          threshold: 0.5       // Trigger when 50% of page is visible
      } 
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [pageNum, notifyPageVisible]);

  // --- Rendering Logic ---
  useEffect(() => {
    if (!isVisible || !pdfDoc || isRendered) return;

    const render = async () => {
      try {
        const page = await pdfDoc.getPage(pageNum);
        const pixelRatio = window.devicePixelRatio || 1;
        
        const viewport = page.getViewport({ scale: scale });
        const renderViewport = page.getViewport({ scale: scale * pixelRatio });

        setPageDimensions({ width: viewport.width, height: viewport.height });

        if (containerRef.current) {
            containerRef.current.style.setProperty('--scale-factor', scale);
        }

        if (canvasRef.current) {
            const ctx = canvasRef.current.getContext('2d');
            canvasRef.current.width = renderViewport.width;
            canvasRef.current.height = renderViewport.height;
            canvasRef.current.style.width = `${viewport.width}px`;
            canvasRef.current.style.height = `${viewport.height}px`;

            await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
        }

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

            const spans = Array.from(textLayerRef.current.querySelectorAll('span'));
            let localTokens = [];
            let localIdCounter = 0;

            spans.forEach(span => {
                const text = span.textContent;
                if (!text.trim()) return;

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
            setIsRendered(true);
        }
      } catch (err) {
        console.error(`Error rendering page ${pageNum}`, err);
      }
    };
    render();
  }, [isVisible, pdfDoc, pageNum, scale, isRendered]);

  const handlePageClick = (e) => {
    let range;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(e.clientX, e.clientY);
    else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.setEnd(pos.offsetNode, pos.offset);
    }
    
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return;

    const targetSpan = range.startContainer.parentElement;
    const clickOffset = range.startOffset;
    const tokensInSpan = spanMapRef.current.get(targetSpan);

    if (tokensInSpan) {
        const clickedToken = tokensInSpan.find(t => clickOffset >= t.startOffset && clickOffset <= t.endOffset);
        if (clickedToken) {
            onTokensParsed(pageTokensRef.current, clickedToken.id);
        }
    }
  };

  const highlightStyle = useMemo(() => {
    if (!activeTokenId || !pageTokensRef.current.length || !containerRef.current) return null;
    
    const activeToken = pageTokensRef.current.find(t => t.id === activeTokenId);
    if (!activeToken) return null;

    try {
        const range = document.createRange();
        range.setStart(activeToken.spanElement.firstChild, activeToken.startOffset);
        range.setEnd(activeToken.spanElement.firstChild, activeToken.endOffset);
        
        const rect = range.getBoundingClientRect();
        const containerRect = containerRef.current.getBoundingClientRect();

        return {
            left: rect.left - containerRect.left,
            top: rect.top - containerRect.top,
            width: rect.width,
            height: rect.height
        };
    } catch (e) { return null; }
  }, [activeTokenId]);

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
        boxShadow: '0 2px 5px rgba(0,0,0,0.1)'
      }}
    >
      {isVisible && (
        <>
            <canvas ref={canvasRef} style={{ display: 'block' }} />
            <div ref={textLayerRef} className="textLayer" onClick={handlePageClick} />
            {highlightStyle && (
                 <div className="highlight-box" style={{ ...highlightStyle }} />
            )}
        </>
      )}
      {!isVisible && (
          <div className="loading-placeholder">
              <span>Page {pageNum}</span>
          </div>
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
  const [isInputFocused, setIsInputFocused] = useState(false); // To prevent scroll overwriting typing

  // TTS State
  const [voices, setVoices] = useState([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState("");
  const [currentTokens, setCurrentTokens] = useState([]);
  const [activeTokenId, setActiveTokenId] = useState(null);

  // Refs
  const isPlayingRef = useRef(false); 
  const rateRef = useRef(1.0);
  const audioMapRef = useRef([]); 
  const isSwitchingRef = useRef(false);
  const synth = window.speechSynthesis;
  
  const pageRefs = useRef({}); 

  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { rateRef.current = rate; }, [rate]);

  // Sync Input box with Scroll
  useEffect(() => {
    // Only update input from scroll if user isn't currently typing
    if (!isInputFocused) {
        setJumpInput(String(activePage));
    }
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
    synth.cancel();
  };

  const registerPageRef = (num, el) => {
      pageRefs.current[num] = el;
  };

  const notifyPageVisible = useCallback((pageNum) => {
      setActivePage(pageNum);
  }, []);

  // Handle "Jump to Page" on Enter
  const handleJumpKey = (e) => {
      if (e.key === 'Enter') {
          const page = parseInt(jumpInput);
          if (page >= 1 && page <= numPages && pageRefs.current[page]) {
              pageRefs.current[page].scrollIntoView({ behavior: 'smooth', block: 'start' });
              e.target.blur(); // Remove focus after jump
          }
      }
  };

  const handleTokenClick = useCallback((pageTokens, clickedTokenId) => {
      setCurrentTokens(pageTokens);
      isSwitchingRef.current = true;
      synth.cancel();
      setIsPlaying(true);
      isPlayingRef.current = true;
      speakFromToken(clickedTokenId, pageTokens);
      setTimeout(() => { isSwitchingRef.current = false; }, 200);
  }, [voices, selectedVoiceURI, rate]);

  const speakFromToken = (startTokenId, tokensToRead = currentTokens) => {
    if (!isPlayingRef.current) return;

    let script = "";
    const map = []; 

    let startIndexInArray = 0;
    if (startTokenId) {
        startIndexInArray = tokensToRead.findIndex(t => t.id === startTokenId);
        if (startIndexInArray === -1) startIndexInArray = 0;
    }

    for (let i = startIndexInArray; i < tokensToRead.length; i++) {
        const token = tokensToRead[i];
        const start = script.length;
        const textToRead = token.spokenText;
        const end = start + textToRead.length;
        map.push({ start, end, token });
        script += textToRead + " "; 
    }

    audioMapRef.current = map;
    if (!script.trim()) return;

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
        setIsPlaying(false);
        setActiveTokenId(null);
    };
    
    utter.onerror = () => setIsPlaying(false);
    synth.speak(utter);
  };

  const togglePlay = () => {
    if (isPlaying) {
        setIsPlaying(false);
        isPlayingRef.current = false;
        synth.cancel();
    } else {
        setIsPlaying(true);
        isPlayingRef.current = true;
        speakFromToken(activeTokenId || (currentTokens[0] ? currentTokens[0].id : undefined)); 
    }
  };

  return (
    <div className="app-layout">
      <main className="main-content">
        <div className="scroll-viewport">
            {!pdf ? (
                <div className="empty-placeholder">
                    <h3>PDF Audio Reader</h3>
                    <p>Continuous Scroll & Lazy Loading Enabled</p>
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
                        />
                    ))}
                </div>
            )}
        </div>

        {pdf && (
            <div className="player-bar">
                <div className="player-controls">
                    <button className="play-fab" onClick={togglePlay}>
                        {isPlaying ? <Icons.Pause /> : <Icons.Play />}
                    </button>
                    
                    {/* Simplified Jump Control */}
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
        
        /* Continuous Scroll Viewport */
        .scroll-viewport { flex: 1; overflow-y: auto; display: flex; justify-content: center; padding: 40px 0 120px 0; scroll-behavior: smooth; }
        .pdf-stream { display: flex; flex-direction: column; align-items: center; gap: 20px; width: 100%; }
        
        .pdf-page-container { transition: box-shadow 0.2s;position: relative;}
        canvas { display: block; }
        .textLayer { position: absolute; top: 0; left: 0; right: 0; bottom: 0; overflow: hidden; opacity: 1; line-height: 1.0; transform-origin: 0 0; z-index: 2; }
        .textLayer span { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; }
        .highlight-box { position: absolute; background-color: rgba(99, 102, 241, 0.3); border: 2px solid #6366f1; border-radius: 2px; pointer-events: none; z-index: 10; mix-blend-mode: multiply; transition: all 0.05s linear; }
        
        .loading-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: #27272a; color: #52525b; border: 1px dashed #3f3f46; }

        .empty-placeholder { display:flex; flex-direction:column; align-items:center; margin-top: 30vh; color: #555; gap: 20px; }
        .empty-placeholder h3 { font-weight: 400; font-size: 24px; color: #71717a; margin: 0; }

        .upload-btn { display: flex; align-items: center; justify-content: center; gap: 8px; background: #27272a; color: #e4e4e7; padding: 10px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 14px; border: 1px solid #3f3f46; transition: all 0.2s; }
        .upload-btn:hover { background: #3f3f46; border-color: #6366f1; }
        .upload-btn.main-upload { background: #6366f1; color: white; border: none; padding: 12px 24px; font-size: 16px; }

        /* Player Bar */
        .player-bar { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); width: 700px; background: rgba(39, 39, 42, 0.95); border: 1px solid #3f3f46; border-radius: 16px; padding: 12px 24px; display: flex; align-items: center; gap: 20px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); z-index: 100; backdrop-filter: blur(10px); }
        .player-controls { display: flex; align-items: center; gap: 16px; flex-shrink: 0; }
        .play-fab { width: 40px; height: 40px; border-radius: 50%; background: #fff; color: #000; border: none; cursor: pointer; display: grid; place-items: center; }
        
        .jump-group { display: flex; align-items: center; gap: 5px; background: #18181b; padding: 4px 12px; border-radius: 6px; border: 1px solid #3f3f46; height: 32px; }
        .jump-group .label { font-size: 12px; color: #71717a; white-space: nowrap; }
        .page-input { width: 32px; background: transparent; border: none; color: #fff; text-align: center; font-size: 13px; outline: none; font-weight: 600; }
        .page-input:focus { color: #6366f1; }
        .page-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

        .voice-group { display: flex; align-items: center; gap: 8px; flex: 1; color: #a1a1aa; min-width: 0; }
        .voice-select { flex: 1; background: #27272a; color: #e4e4e7; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px; font-size: 12px; outline: none; cursor: pointer; width: 100%; }
        
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