import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Icons } from './Icons';

// --- Text Merging Heuristics ---
// Constants relative to font height to ensure zoom/scale invariance.
const MERGE_CONFIG = {
  // If the vertical difference between two tokens is > 50% of the font height,
  // we consider them to be on separate lines.
  MAX_VERTICAL_MISALIGNMENT: 0.5, 

  // Max allowable horizontal gap between letters to merge them.
  // 0.1 (10%) handles tiny rendering gaps but is strictly smaller than a 
  // space character (usually ~0.25 - 0.33).
  MAX_INTRA_WORD_GAP: 0.1, 

  // Max allowable overlap (negative gap) between letters.
  // 0.5 (50%) allows for italics (leaning characters) and ligatures (fi, fl)
  // but prevents merging text that is simply printed on top of other text.
  MAX_ALLOWED_OVERLAP: 0.5  
};

const isTokenInZone = (tokenRect, zoneRect) => {
  return !(
    tokenRect.right < zoneRect.left ||
    tokenRect.left > zoneRect.right ||
    tokenRect.bottom < zoneRect.top ||
    tokenRect.top > zoneRect.bottom
  );
};

const PDFPage = ({ 
  pdfDoc, 
  pageNum, 
  scale, 
  rotation, 
  onTokensParsed, 
  activeTokenId, 
  registerPageRef,
  notifyPageVisible,
  registerPageTokens,
  isMarkingMode,
  skipZones,
  onAddSkipZone,
  onRemoveSkipZone
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [pageDimensions, setPageDimensions] = useState(null); 
  const [hoveredTokenId, setHoveredTokenId] = useState(null);
  
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
        
        const viewport = page.getViewport({ 
            scale: scale, 
            rotation: (page.rotate + rotation) % 360 
        });
        const renderViewport = page.getViewport({ 
            scale: scale * pixelRatio, 
            rotation: (page.rotate + rotation) % 360 
        });

        setPageDimensions({ width: viewport.width, height: viewport.height });

        if (containerRef.current) containerRef.current.style.setProperty('--scale-factor', scale);

        // Render Canvas
        if (canvasRef.current) {
            const ctx = canvasRef.current.getContext('2d');
            canvasRef.current.width = renderViewport.width;
            canvasRef.current.height = renderViewport.height;
            canvasRef.current.style.width = `${viewport.width}px`;
            canvasRef.current.style.height = `${viewport.height}px`;
            
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

            const spans = Array.from(textLayerRef.current.querySelectorAll('span'));
            let rawTokens = [];
            
            // 1. Extraction Pass: Get atomic tokens and physical bounds
            spans.forEach(span => {
                const text = span.textContent;
                if (!text.trim()) return; 

                const containerRect = containerRef.current.getBoundingClientRect();
                
                const regex = /\S+/g;
                let match;
                while ((match = regex.exec(text)) !== null) {
                    const range = document.createRange();
                    range.setStart(span.firstChild, match.index);
                    range.setEnd(span.firstChild, regex.lastIndex);
                    const rect = range.getBoundingClientRect();

                    rawTokens.push({
                        text: match[0],
                        spanElement: span,
                        startOffset: match.index,
                        endOffset: regex.lastIndex,
                        bounds: {
                            left: rect.left - containerRect.left,
                            top: rect.top - containerRect.top,
                            right: rect.right - containerRect.left,
                            bottom: rect.bottom - containerRect.top,
                            width: rect.width,
                            height: rect.height
                        }
                    });
                }
            });

            // 2. Merging Pass: Combine touching tokens
            const mergedTokens = [];
            if (rawTokens.length > 0) {
                // FIXED: Do NOT sort rawTokens. 
                // We rely on the DOM order provided by PDF.js, which usually respects 
                // the logical reading order (columns, forms, etc.).
                // We only merge if items are sequential in the DOM AND physically touching.

                let currentToken = rawTokens[0];
                currentToken.parts = [rawTokens[0]]; 

                for (let i = 1; i < rawTokens.length; i++) {
                    const nextToken = rawTokens[i];
                    const prevBounds = currentToken.bounds;
                    const nextBounds = nextToken.bounds;

                    // Check 1: Vertical Alignment (Same Line?)
                    const isSameLine = Math.abs(prevBounds.top - nextBounds.top) < 
                                     (prevBounds.height * MERGE_CONFIG.MAX_VERTICAL_MISALIGNMENT);
                    
                    // Check 2: Horizontal Proximity (Touching?)
                    const gap = nextBounds.left - prevBounds.right;
                    
                    const isGapSmallEnough = gap < (prevBounds.height * MERGE_CONFIG.MAX_INTRA_WORD_GAP);
                    const isOverlapAcceptable = gap > -(prevBounds.height * MERGE_CONFIG.MAX_ALLOWED_OVERLAP);
                    
                    const isTouching = isGapSmallEnough && isOverlapAcceptable;

                    if (isSameLine && isTouching) {
                        // MERGE
                        currentToken.text += nextToken.text;
                        
                        // Union Bounds
                        const newLeft = Math.min(prevBounds.left, nextBounds.left);
                        const newTop = Math.min(prevBounds.top, nextBounds.top);
                        const newRight = Math.max(prevBounds.right, nextBounds.right);
                        const newBottom = Math.max(prevBounds.bottom, nextBounds.bottom);
                        
                        currentToken.bounds = {
                            left: newLeft,
                            top: newTop,
                            right: newRight,
                            bottom: newBottom,
                            width: newRight - newLeft,
                            height: newBottom - newTop
                        };
                        currentToken.parts.push(nextToken);
                    } else {
                        // PUSH & RESET
                        mergedTokens.push(currentToken);
                        currentToken = nextToken;
                        currentToken.parts = [nextToken];
                    }
                }
                mergedTokens.push(currentToken);
            }

            // 3. Finalize & Register
            let finalTokens = [];
            spanMapRef.current.clear(); 

            mergedTokens.forEach((t, index) => {
                const finalToken = {
                    id: `p${pageNum}_t${index}`,
                    pageNum,
                    text: t.text,
                    spokenText: t.text,
                    bounds: t.bounds,
                    parts: t.parts
                };

                const isSkipped = skipZones.some(zone => {
                     const zonePx = {
                        left: zone.x * viewport.width,
                        top: zone.y * viewport.height,
                        right: (zone.x + zone.w) * viewport.width,
                        bottom: (zone.y + zone.h) * viewport.height
                    };
                    return isTokenInZone(finalToken.bounds, zonePx);
                });

                if (isSkipped) {
                    t.parts.forEach(p => {
                        p.spanElement.style.opacity = '0.2';
                        p.spanElement.style.textDecoration = 'line-through';
                    });
                    return; 
                }

                t.parts.forEach(part => {
                    const existing = spanMapRef.current.get(part.spanElement) || [];
                    existing.push(finalToken);
                    spanMapRef.current.set(part.spanElement, existing);
                });

                finalTokens.push(finalToken);
            });

            // DEBUG LOGGING
            const pageTranscript = finalTokens.map(t => t.text).join(' ');
            console.log(`[DEBUG] Page ${pageNum} Transcript:`, pageTranscript);

            pageTokensRef.current = finalTokens;
            registerPageTokens(pageNum, finalTokens);
        }
      } catch (err) {
        console.error(`Error rendering page ${pageNum}`, err);
      }
    };

    render();
    return () => { isCancelled = true; };
  }, [isVisible, pdfDoc, pageNum, scale, rotation, skipZones, registerPageTokens]);

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
    if (isMarkingMode) return null;
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
    const candidates = spanMapRef.current.get(targetSpan);
    if (!candidates) return null;
    
    if (candidates.length === 1) return candidates[0];

    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    return candidates.find(t => 
        mouseX >= t.bounds.left && 
        mouseX <= t.bounds.right && 
        mouseY >= t.bounds.top && 
        mouseY <= t.bounds.bottom
    );
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
    if (!tokenId || !pageTokensRef.current.length) return null;
    const token = pageTokensRef.current.find(t => t.id === tokenId);
    if (!token || !token.bounds) return null;
    return token.bounds; 
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
        cursor: isMarkingMode ? 'crosshair' : 'default',
        userSelect: isMarkingMode ? 'none' : 'auto'
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
                style={{ pointerEvents: isMarkingMode ? 'none' : 'auto' }}
            />
            {activeStyle && !isMarkingMode && <div className="highlight-box" style={activeStyle} />}
            {hoverStyle && !isMarkingMode && <div className="hover-box" style={hoverStyle} />}

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

export default PDFPage;