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

  // Skip State
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
    </div>
  );
};

export default App;