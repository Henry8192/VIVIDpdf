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
  Close: () => <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Voice: () => <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
};

const App = () => {
  const [pdf, setPdf] = useState(null);
  const [fileName, setFileName] = useState("");
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
   
  const [highlight, setHighlight] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [rate, setRate] = useState(1.0);

  // --- Voice State ---
  const [voices, setVoices] = useState([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState("");

  // --- Core Data: Tokens (Word Granularity) ---
  const [tokens, setTokens] = useState([]);
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

  // Load Voices
  useEffect(() => {
    const loadVoices = () => {
      const available = window.speechSynthesis.getVoices();
      setVoices(available);
      if (available.length > 0 && !selectedVoiceURI) {
        // Default to a local English voice if available, else first
        const defaultVoice = available.find(v => v.default) || available[0];
        setSelectedVoiceURI(defaultVoice?.voiceURI || "");
      }
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => { window.speechSynthesis.onvoiceschanged = null; };
  }, [selectedVoiceURI]);

  // 1. PDF Loading & Parsing
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

    const visualScale = 1.5; 
    const pixelRatio = window.devicePixelRatio || 1; 

    const displayViewport = page.getViewport({ scale: visualScale });
    const renderViewport = page.getViewport({ scale: visualScale * pixelRatio });

    if (containerRef.current) {
        containerRef.current.style.width = `${displayViewport.width}px`;
        containerRef.current.style.height = `${displayViewport.height}px`;
        containerRef.current.style.setProperty('--scale-factor', visualScale);
    }

    if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        canvasRef.current.width = renderViewport.width;
        canvasRef.current.height = renderViewport.height;
        canvasRef.current.style.width = `${displayViewport.width}px`;
        canvasRef.current.style.height = `${displayViewport.height}px`;

        await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
    }

    if (textLayerRef.current) {
        textLayerRef.current.innerHTML = '';
        textLayerRef.current.style.width = `${displayViewport.width}px`;
        textLayerRef.current.style.height = `${displayViewport.height}px`;

        const textContent = await page.getTextContent();
        await pdfjsLib.renderTextLayer({
            textContent: textContent,
            container: textLayerRef.current,
            viewport: displayViewport, 
            enhanceTextSelection: true
        }).promise;

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

  // 2. Speech Engine
  const speakFromToken = (startTokenId) => {
    if (!isPlayingRef.current) return;

    let script = "";
    const map = []; 

    let startIndexInArray = 0;
    if (startTokenId !== undefined) {
        startIndexInArray = tokens.findIndex(t => t.id === startTokenId);
        if (startIndexInArray === -1) startIndexInArray = 0;
    }

    for (let i = startIndexInArray; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.isSkipped) continue;

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
    
    // Apply Selected Voice
    const targetVoice = voices.find(v => v.voiceURI === selectedVoiceURI);
    if (targetVoice) {
        utter.voice = targetVoice;
        utter.lang = targetVoice.lang;
    } else {
        // Fallback detection if no voice selected
        const isChinese = /[\u4e00-\u9fa5]/.test(script.trim()[0]);
        utter.lang = isChinese ? 'zh-CN' : 'en-US';
    }

    utter.onboundary = (event) => {
        if (!isPlayingRef.current) { synth.cancel(); return; }
        
        const currentIdx = event.charIndex;
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
      } catch (e) { }
  };

  // 3. Interaction Logic
  const handleCanvasClick = (e) => {
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

    const tokensInSpan = spanToTokensMap.current.get(targetSpan);
    if (tokensInSpan) {
        const clickedToken = tokensInSpan.find(t => clickOffset >= t.startOffset && clickOffset <= t.endOffset);
        
        if (clickedToken) {
            if (clickedToken.isSkipped) return;

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

  const handleVoiceChange = (e) => {
    const newVoice = e.target.value;
    setSelectedVoiceURI(newVoice);
    if (isPlaying) {
        synth.cancel();
        // Short timeout to allow state to settle and cancel to finish
        setTimeout(() => {
             speakFromToken(); // Resume from start or store current index (advanced)
        }, 50);
    }
  };

  // 4. Editor Interaction Logic
  const handleTokenSelect = (tokenId, isMultiSelect) => {
      if (isMultiSelect) {
          setSelectedTokenIds(prev => prev.includes(tokenId) ? prev.filter(id => id !== tokenId) : [...prev, tokenId]);
      } else {
          setSelectedTokenIds([tokenId]);
      }
      setEditorMode(null); 
  };

  const handleSkip = () => {
      setTokens(prev => prev.map(t => selectedTokenIds.includes(t.id) ? { ...t, isSkipped: !t.isSkipped } : t));
      setSelectedTokenIds([]); 
  };

  const handleEditStart = () => {
      const firstToken = tokens.find(t => t.id === selectedTokenIds[0]);
      if (firstToken) {
          setEditValue(firstToken.spokenText);
          setEditorMode('edit');
      }
  };

  const handleEditConfirm = () => {
      const sortedIds = [...selectedTokenIds].sort((a,b) => a-b);
      
      setTokens(prev => prev.map(t => {
          if (t.id === sortedIds[0]) {
              return { ...t, spokenText: editValue };
          } else if (sortedIds.includes(t.id)) {
              return { ...t, spokenText: "" }; 
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

        <div className="transcript-content">
            {tokens.length === 0 && <div className="hint-text">Load PDF to view script</div>}
            
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
                
                {/* Voice Selector */}
                <div className="voice-group">
                    <Icons.Voice />
                    <select value={selectedVoiceURI} onChange={handleVoiceChange} className="voice-select">
                        {voices.map(v => (
                            <option key={v.voiceURI} value={v.voiceURI}>
                                {v.name.slice(0, 20) + (v.name.length > 20 ? "..." : "")} ({v.lang})
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
        .script-word.modified { color: #34d399; border-bottom: 1px dotted #34d399; }

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
        .player-bar { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); width: 600px; background: rgba(39, 39, 42, 0.95); border: 1px solid #3f3f46; border-radius: 16px; padding: 12px 24px; display: flex; align-items: center; gap: 20px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); z-index: 100; backdrop-filter: blur(10px); }
        .player-controls { display: flex; align-items: center; gap: 16px; flex-shrink: 0; }
        .play-fab { width: 40px; height: 40px; border-radius: 50%; background: #fff; color: #000; border: none; cursor: pointer; display: grid; place-items: center; }
        .player-status { font-size: 13px; color: #fff; font-weight: 500; min-width: 60px; }
        
        .voice-group { display: flex; align-items: center; gap: 8px; flex: 1; color: #a1a1aa; min-width: 0; }
        .voice-select { flex: 1; background: #27272a; color: #e4e4e7; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px; font-size: 12px; outline: none; cursor: pointer; width: 100%; text-overflow: ellipsis; }
        .voice-select:hover { border-color: #6366f1; }
        
        .speed-slider-group { display: flex; align-items: center; gap: 10px; color: #fff; font-size: 12px; flex-shrink: 0; }
        input[type=range] { width: 80px; accent-color: #6366f1; }
        .speed-val { width: 30px; text-align: right; }
        
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 3px; }
      `}</style>
    </div>
  );
};

export default App;