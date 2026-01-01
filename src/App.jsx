import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;

// --- Icon Components ---
const Icons = {
  Upload: () => <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>,
  Prev: () => <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>,
  Next: () => <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>,
  Play: () => <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>,
  Pause: () => <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>,
  File: () => <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>,
  Edit: () => <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  EyeOff: () => <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M1 1l22 22"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/></svg>,
  Check: () => <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>,
  Close: () => <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
};

const App = () => {
  const [pdf, setPdf] = useState(null);
  const [fileName, setFileName] = useState("");
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  
  const [highlight, setHighlight] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [rate, setRate] = useState(1.0);

  // --- Core Data: Tokens (Word Granularity) ---
  // Each Token = { id, text, spokenText, isSkipped, spanElement, startOffset, endOffset }
  const [tokens, setTokens] = useState([]);
  // Map for click interactions: SpanElement -> [Token1, Token2...]
  const spanToTokensMap = useRef(new Map());
  
  // Editor State
  const [selectedTokenIds, setSelectedTokenIds] = useState([]);
  const [editorMode, setEditorMode] = useState(null); // 'edit' | null
  const [editValue, setEditValue] = useState("");

  const isPlayingRef = useRef(false); 
  const rateRef = useRef(1.0);
  const isSwitchingRef = useRef(false);
  const audioMapRef = useRef([]); // Playback index -> Token
  
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const textLayerRef = useRef(null);
  const synth = window.speechSynthesis;

  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { rateRef.current = rate; }, [rate]);

  // 1. PDF Loading & Parsing (Word-Level Tokenization)
  const onFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    const data = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdfDoc = await loadingTask.promise;
    setPdf(pdfDoc);
    setNumPages(pdfDoc.numPages);
    setPageNum(1);
  };

  const renderPage = useCallback(async (num) => {
    if (!pdf) return;
    setHighlight(null);
    setIsPlaying(false);
    isPlayingRef.current = false;
    synth.cancel();
    setTokens([]);
    spanToTokensMap.current.clear();

    const page = await pdf.getPage(num);

    // --- DPI FIX START ---
    const visualScale = 1.5; // Controls the visual zoom size
    const pixelRatio = window.devicePixelRatio || 1; // e.g., 2.0 on Retina

    // 1. Viewport for Layout (Text Layer & Container CSS)
    const displayViewport = page.getViewport({ scale: visualScale });

    // 2. Viewport for Rendering (Canvas Resolution)
    // We multiply by pixelRatio to generate high-res pixels
    const renderViewport = page.getViewport({ scale: visualScale * pixelRatio });
    // --- DPI FIX END ---

    if (containerRef.current) {
        // Container matches the visual size
        containerRef.current.style.width = `${displayViewport.width}px`;
        containerRef.current.style.height = `${displayViewport.height}px`;
        containerRef.current.style.setProperty('--scale-factor', visualScale);
    }

    if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');

        // Set actual pixel dimensions to High Res
        canvasRef.current.width = renderViewport.width;
        canvasRef.current.height = renderViewport.height;

        // Force CSS to shrink it back to visual size
        canvasRef.current.style.width = `${displayViewport.width}px`;
        canvasRef.current.style.height = `${displayViewport.height}px`;

        // Render using the High Res viewport
        await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
    }

    if (textLayerRef.current) {
        textLayerRef.current.innerHTML = '';
        // Text layer matches visual size to align with CSS
        textLayerRef.current.style.width = `${displayViewport.width}px`;
        textLayerRef.current.style.height = `${displayViewport.height}px`;

        const textContent = await page.getTextContent();
        await pdfjsLib.renderTextLayer({
            textContent: textContent,
            container: textLayerRef.current,
            viewport: displayViewport, // Critical: Use displayViewport here so text aligns with cursor
            enhanceTextSelection: true
        }).promise;

        // --- Core: Decompose Spans into Words (Tokens) ---
        // (Rest of your existing logic remains exactly the same)
        const spans = Array.from(textLayerRef.current.querySelectorAll('span'));
        let allTokens = [];
        let globalId = 0;

        spans.forEach(span => {
            const text = span.textContent;
            const regex = /\S+/g; 
            let match;
            const spanTokens = [];

            while ((match = regex.exec(text)) !== null) {
                const token = {
                    id: globalId++,
                    text: match[0],          
                    spokenText: match[0],    
                    isSkipped: false,        
                    spanElement: span,       
                    startOffset: match.index,
                    endOffset: regex.lastIndex 
                };
                allTokens.push(token);
                spanTokens.push(token);
            }
            spanToTokensMap.current.set(span, spanTokens);
        });
        
        setTokens(allTokens);
    }
  }, [pdf]);
  
  useEffect(() => {
    if (pdf) renderPage(pageNum);
  }, [pdf, pageNum, renderPage]);

  // 2. Speech Engine (Token-based)
  const speakFromToken = (startTokenId) => {
    if (!isPlayingRef.current) return;

    // Build synthesis script
    let script = "";
    const map = []; // Char Index -> Token

    // Find starting Token index
    let startIndexInArray = 0;
    if (startTokenId !== undefined) {
        startIndexInArray = tokens.findIndex(t => t.id === startTokenId);
        if (startIndexInArray === -1) startIndexInArray = 0;
    }

    // Concatenate from the click position onwards
    for (let i = startIndexInArray; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.isSkipped) continue;

        const start = script.length;
        const textToRead = token.spokenText;
        const end = start + textToRead.length;

        // Record mapping
        map.push({ start, end, token });
        
        script += textToRead + " "; // Add space for natural pause
    }

    audioMapRef.current = map;
    
    if (!script.trim()) return;

    const utter = new SpeechSynthesisUtterance(script);
    utter.rate = rateRef.current;
    
    // Automatic language detection (simple check of first character)
    const isChinese = /[\u4e00-\u9fa5]/.test(script.trim()[0]);
    utter.lang = isChinese ? 'zh-CN' : 'en-US';

    utter.onboundary = (event) => {
        if (!isPlayingRef.current) { synth.cancel(); return; }
        
        const currentIdx = event.charIndex;
        // Lookup in map
        const entry = audioMapRef.current.find(m => currentIdx >= m.start && currentIdx < m.end);
        
        if (entry) {
            highlightToken(entry.token);
        }
    };

    utter.onend = () => {
        if (isSwitchingRef.current) return;
        setIsPlaying(false);
    };
    
    utter.onerror = () => setIsPlaying(false);
    synth.speak(utter);
  };

  const highlightToken = (token) => {
      try {
          const range = document.createRange();
          // Highlight using precise Word offsets
          range.setStart(token.spanElement.firstChild, token.startOffset);
          range.setEnd(token.spanElement.firstChild, token.endOffset);
          
          const rect = range.getBoundingClientRect();
          const containerRect = containerRef.current.getBoundingClientRect();
          
          setHighlight({
              x: rect.left - containerRect.left,
              y: rect.top - containerRect.top,
              w: rect.width,
              h: rect.height
          });
      } catch (e) {
          // Fallback: If Range fails (e.g., span re-rendered), try highlighting the whole span
          // console.warn(e);
      }
  };

  // 3. Interaction Logic
  const handleCanvasClick = (e) => {
    // ... Find click position ...
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

    // Reverse lookup Token
    const tokensInSpan = spanToTokensMap.current.get(targetSpan);
    if (tokensInSpan) {
        // Find the Token containing the click Offset
        const clickedToken = tokensInSpan.find(t => clickOffset >= t.startOffset && clickOffset <= t.endOffset);
        
        if (clickedToken) {
            if (clickedToken.isSkipped) {
                // If a skipped word is clicked, opt not to highlight or alert
                return;
            }

            // Toggle playback
            isSwitchingRef.current = true;
            synth.cancel();
            setIsPlaying(true);
            isPlayingRef.current = true;
            speakFromToken(clickedToken.id);
            setTimeout(() => { isSwitchingRef.current = false; }, 200);
        }
    }
  };

  const togglePlay = () => {
    if (isPlaying) {
        setIsPlaying(false);
        isPlayingRef.current = false;
        synth.cancel();
    } else {
        setIsPlaying(true);
        isPlayingRef.current = true;
        speakFromToken(); 
    }
  };

  // 4. Editor Interaction Logic
  const handleTokenSelect = (tokenId, isMultiSelect) => {
      if (isMultiSelect) {
          setSelectedTokenIds(prev => prev.includes(tokenId) ? prev.filter(id => id !== tokenId) : [...prev, tokenId]);
      } else {
          setSelectedTokenIds([tokenId]);
      }
      setEditorMode(null); // Reset edit mode
  };

  const handleSkip = () => {
      setTokens(prev => prev.map(t => selectedTokenIds.includes(t.id) ? { ...t, isSkipped: !t.isSkipped } : t));
      setSelectedTokenIds([]); // Clear selection after operation
  };

  const handleEditStart = () => {
      // Get the text of the first selected token as initial value
      const firstToken = tokens.find(t => t.id === selectedTokenIds[0]);
      if (firstToken) {
          setEditValue(firstToken.spokenText);
          setEditorMode('edit');
      }
  };

  const handleEditConfirm = () => {
      // Change the first selected token to new text, set others to empty or merge logic
      // Simple strategy: Modify spokenText of the first token, keep others as is or skip?
      // Better strategy: Only modify the spokenText of the first selected token. If multiple are selected, intention is usually to change the reading for the group.
      // E.g., "Seq No" -> "Sequence Number". Token1="Seq", Token2="No".
      // We set Token1.spoken = "Sequence Number", Token2.spoken = "" (empty string not read)
      
      const firstId = selectedTokenIds[0]; // Assume IDs are ordered, better to sort them
      const sortedIds = [...selectedTokenIds].sort((a,b) => a-b);
      
      setTokens(prev => prev.map(t => {
          if (t.id === sortedIds[0]) {
              return { ...t, spokenText: editValue };
          } else if (sortedIds.includes(t.id)) {
              return { ...t, spokenText: "" }; // Do not read other selected words
          }
          return t;
      }));
      
      setEditorMode(null);
      setSelectedTokenIds([]);
  };

  return (
    <div className="app-layout">
      {/* --- Left Side: Smart Script Editor --- */}
      <aside className="sidebar">
        <div className="brand">
          <div className="logo-icon">SR</div>
          <h1>Transcript</h1>
        </div>

        {/* Script Content Area (Document View) */}
        <div className="transcript-content">
            {tokens.length === 0 && <div className="hint-text">Load PDF to view script</div>}
            
            {/* Render Word Stream */}
            <div className="word-stream">
                {tokens.map(token => (
                    <span 
                        key={token.id}
                        className={`
                            script-word 
                            ${selectedTokenIds.includes(token.id) ? 'selected' : ''}
                            ${token.isSkipped ? 'skipped' : ''}
                            ${token.spokenText !== token.text && !token.isSkipped ? 'modified' : ''}
                        `}
                        onClick={(e) => handleTokenSelect(token.id, e.metaKey || e.ctrlKey)}
                    >
                        {token.text}
                    </span>
                ))}
            </div>
        </div>

        {/* Bottom Action Bar (Appears when selected) */}
        {selectedTokenIds.length > 0 && (
            <div className="action-panel">
                {editorMode === 'edit' ? (
                    <div className="edit-box">
                        <input 
                            autoFocus
                            value={editValue} 
                            onChange={e => setEditValue(e.target.value)} 
                            onKeyDown={e => e.key === 'Enter' && handleEditConfirm()}
                        />
                        <button onClick={handleEditConfirm}><Icons.Check /></button>
                        <button onClick={() => setEditorMode(null)}><Icons.Close /></button>
                    </div>
                ) : (
                    <div className="btn-group">
                        <button onClick={handleEditStart} className="btn-action">
                            <Icons.Edit /> Edit Text
                        </button>
                        <button onClick={handleSkip} className="btn-action">
                            <Icons.EyeOff /> {tokens.find(t => t.id === selectedTokenIds[0])?.isSkipped ? "Unskip" : "Skip"}
                        </button>
                    </div>
                )}
            </div>
        )}

        <div className="sidebar-footer">
             <label className="upload-btn">
                <Icons.Upload /> Open PDF
                <input type="file" accept="application/pdf" onChange={onFileChange} style={{display:'none'}} />
            </label>
        </div>
      </aside>

      {/* --- Right Side: PDF Reader --- */}
      <main className="main-content">
        <div className="reader-viewport">
            {!pdf ? <div className="empty-placeholder"><h3>Ready to Read</h3></div> : (
                <div className="pdf-surface">
                    <div ref={containerRef} className="pdf-container">
                        <canvas ref={canvasRef} />
                        <div ref={textLayerRef} className="textLayer" onClick={handleCanvasClick} />
                        {highlight && (
                            <div className="highlight-box" style={{
                                left: highlight.x, top: highlight.y, width: highlight.w, height: highlight.h
                            }} />
                        )}
                    </div>
                </div>
            )}
        </div>

        {pdf && (
            <div className="player-bar">
                <div className="player-controls">
                    <button className="play-fab" onClick={togglePlay}>
                        {isPlaying ? <Icons.Pause /> : <Icons.Play />}
                    </button>
                    <div className="player-info">
                        <span className="player-status">{isPlaying ? "Reading..." : "Paused"}</span>
                    </div>
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
        
        /* Sidebar (Script Editor) */
        .sidebar { width: 320px; background: #18181b; border-right: 1px solid #27272a; display: flex; flex-direction: column; flex-shrink: 0; position: relative; }
        .brand { padding: 20px; border-bottom: 1px solid #27272a; display: flex; align-items: center; gap: 10px; }
        .logo-icon { width: 24px; height: 24px; background: #6366f1; border-radius: 6px; color: #fff; display: grid; place-items: center; font-weight: bold; font-size: 12px; }
        .brand h1 { font-size: 16px; font-weight: 600; margin: 0; color: #fff; }
        
        .transcript-content { flex: 1; overflow-y: auto; padding: 20px; font-size: 14px; line-height: 1.6; color: #a1a1aa; }
        .word-stream { display: flex; flex-wrap: wrap; gap: 4px; align-content: flex-start; }
        
        /* Token Styles */
        .script-word { cursor: pointer; padding: 1px 3px; border-radius: 4px; transition: all 0.1s; }
        .script-word:hover { background: rgba(255,255,255,0.1); color: #fff; }
        .script-word.selected { background: #6366f1; color: #fff; }
        .script-word.skipped { text-decoration: line-through; opacity: 0.3; }
        .script-word.modified { color: #34d399; border-bottom: 1px dotted #34d399; } /* Modified words show in green */

        .action-panel { padding: 15px; background: #27272a; border-top: 1px solid #3f3f46; }
        .btn-group { display: flex; gap: 10px; }
        .btn-action { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px; background: #3f3f46; border: none; border-radius: 6px; color: #fff; cursor: pointer; font-size: 12px; }
        .btn-action:hover { background: #52525b; }
        
        .edit-box { display: flex; gap: 8px; }
        .edit-box input { flex: 1; background: #18181b; border: 1px solid #6366f1; color: #fff; padding: 6px; border-radius: 4px; outline: none; }
        .edit-box button { background: #3f3f46; border: none; color: #fff; width: 32px; border-radius: 4px; cursor: pointer; display: grid; place-items: center; }
        .edit-box button:hover { background: #6366f1; }

        .sidebar-footer { padding: 15px; border-top: 1px solid #27272a; }
        .upload-btn { display: flex; align-items: center; justify-content: center; gap: 8px; background: #6366f1; color: #fff; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 14px; }
        .upload-btn:hover { opacity: 0.9; }

        /* Main Content */
        .main-content { flex: 1; display: flex; flex-direction: column; position: relative; background: #0f0f11; }
        .reader-viewport { flex: 1; overflow: auto; display: flex; justify-content: center; padding: 40px; }
        .pdf-surface { position: relative; box-shadow: 0 20px 50px rgba(0,0,0,0.5); height: fit-content; }
        .pdf-container { position: relative; background: white; }
        canvas { display: block; }
        .textLayer { position: absolute; top: 0; left: 0; right: 0; bottom: 0; overflow: hidden; opacity: 1; line-height: 1.0; transform-origin: 0 0; }
        .textLayer span { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; }
        .highlight-box { position: absolute; background-color: rgba(99, 102, 241, 0.3); border: 2px solid #6366f1; border-radius: 2px; pointer-events: none; z-index: 10; mix-blend-mode: multiply; transition: all 0.05s linear; }
        
        .empty-placeholder { margin-top: 20vh; color: #555; }
        
        /* Player */
        .player-bar { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); width: 450px; background: rgba(39, 39, 42, 0.95); border: 1px solid #3f3f46; border-radius: 16px; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 20px 40px rgba(0,0,0,0.4); z-index: 100; backdrop-filter: blur(10px); }
        .player-controls { display: flex; align-items: center; gap: 16px; flex: 1; }
        .play-fab { width: 40px; height: 40px; border-radius: 50%; background: #fff; color: #000; border: none; cursor: pointer; display: grid; place-items: center; }
        .player-status { font-size: 13px; color: #fff; font-weight: 500; }
        .speed-slider-group { display: flex; align-items: center; gap: 10px; color: #fff; font-size: 12px; }
        input[type=range] { width: 80px; accent-color: #6366f1; }
        
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 3px; }
      `}</style>
    </div>
  );
};

export default App;