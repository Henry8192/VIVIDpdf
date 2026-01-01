import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;

// --- Icon Components ---
const Icons = {
  Upload: () => <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>,
  Play: () => <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>,
  Pause: () => <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>,
  Voice: () => <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
};

const App = () => {
  const [pdf, setPdf] = useState(null);
  const [pageNum, setPageNum] = useState(1);
  const [highlight, setHighlight] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [rate, setRate] = useState(1.0);

  // --- Voice State ---
  const [voices, setVoices] = useState([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState("");

  // --- Core Data: Tokens ---
  const [tokens, setTokens] = useState([]);
  const spanToTokensMap = useRef(new Map());
  
  const isPlayingRef = useRef(false); 
  const rateRef = useRef(1.0);
  const isSwitchingRef = useRef(false);
  const audioMapRef = useRef([]); 
    
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const textLayerRef = useRef(null);
  const synth = window.speechSynthesis;

  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { rateRef.current = rate; }, [rate]);

  // Log transcript when tokens update
  useEffect(() => {
    if (tokens.length > 0) {
        const fullText = tokens.map(t => t.text).join(' | ');
        console.log("--- Page Transcript ---");
        console.log(fullText);
    }
  }, [tokens]);

  // Load Voices
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

  // 1. PDF Loading & Parsing
  const onFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const data = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdfDoc = await loadingTask.promise;
    setPdf(pdfDoc);
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
    } else {
        const isChinese = /[\u4e00-\u9fa5]/.test(script.trim()[0]);
        utter.lang = isChinese ? 'zh-CN' : 'en-US';
    }

    utter.onboundary = (event) => {
        if (!isPlayingRef.current) { synth.cancel(); return; }
        
        const currentIdx = event.charIndex;
        const entry = audioMapRef.current.find(m => currentIdx >= m.start && currentIdx < m.end);
        
        if (entry) highlightToken(entry.token);
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

  // 3. Interaction Logic (Click to play)
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
        setTimeout(() => speakFromToken(), 50);
    }
  };

  return (
    <div className="app-layout">
      {/* --- Main PDF Reader --- */}
      <main className="main-content">
        <div className="reader-viewport">
            {!pdf ? (
                <div className="empty-placeholder">
                    <h3>PDF Audio Reader</h3>
                    <label className="upload-btn main-upload">
                        <Icons.Upload /> Open PDF File
                        <input type="file" accept="application/pdf" onChange={onFileChange} style={{display:'none'}} />
                    </label>
                </div>
            ) : (
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

                {/* Inline Upload for swapping files */}
                <label className="upload-btn icon-only">
                    <Icons.Upload />
                    <input type="file" accept="application/pdf" onChange={onFileChange} style={{display:'none'}} />
                </label>
            </div>
        )}
      </main>

      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f0f11; color: #e4e4e7; height: 100vh; overflow: hidden; }
        .app-layout { display: flex; height: 100vh; width: 100vw; }
        
        .main-content { flex: 1; display: flex; flex-direction: column; position: relative; background: #0f0f11; }
        .reader-viewport { flex: 1; overflow: auto; display: flex; justify-content: center; padding: 40px; }
        .pdf-surface { position: relative; box-shadow: 0 20px 50px rgba(0,0,0,0.5); height: fit-content; }
        .pdf-container { position: relative; background: white; }
        canvas { display: block; }
        .textLayer { position: absolute; top: 0; left: 0; right: 0; bottom: 0; overflow: hidden; opacity: 1; line-height: 1.0; transform-origin: 0 0; }
        .textLayer span { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; }
        .highlight-box { position: absolute; background-color: rgba(99, 102, 241, 0.3); border: 2px solid #6366f1; border-radius: 2px; pointer-events: none; z-index: 10; mix-blend-mode: multiply; transition: all 0.05s linear; }
        
        .empty-placeholder { display:flex; flex-direction:column; align-items:center; margin-top: 30vh; color: #555; gap: 20px; }
        .empty-placeholder h3 { font-weight: 400; font-size: 24px; color: #71717a; margin: 0; }

        .upload-btn { display: flex; align-items: center; justify-content: center; gap: 8px; background: #27272a; color: #e4e4e7; padding: 10px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 14px; border: 1px solid #3f3f46; transition: all 0.2s; }
        .upload-btn:hover { background: #3f3f46; border-color: #6366f1; }
        .upload-btn.main-upload { background: #6366f1; color: white; border: none; padding: 12px 24px; font-size: 16px; }
        .upload-btn.main-upload:hover { opacity: 0.9; background: #6366f1; }
        .upload-btn.icon-only { padding: 10px; }
        
        /* Player */
        .player-bar { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); width: 640px; background: rgba(39, 39, 42, 0.95); border: 1px solid #3f3f46; border-radius: 16px; padding: 12px 24px; display: flex; align-items: center; gap: 20px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); z-index: 100; backdrop-filter: blur(10px); }
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