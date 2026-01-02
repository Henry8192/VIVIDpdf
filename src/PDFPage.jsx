import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Icons } from './Icons';

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
  rotation, // Receive rotation prop
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
        
        // Base viewport with ROTATION
        const viewport = page.getViewport({ 
            scale: scale, 
            rotation: (page.rotate + rotation) % 360 // Calculate combined rotation
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
            let localTokens = [];
            let localIdCounter = 0;

            spans.forEach(span => {
                const text = span.textContent;
                if (!text.trim()) return;

                const spanLeft = span.offsetLeft;
                const spanTop = span.offsetTop;
                const spanWidth = span.offsetWidth;
                const spanHeight = span.offsetHeight;

                // Check overlap with skip zones
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
                    span.style.opacity = '0.2';
                    span.style.textDecoration = 'line-through';
                    return; 
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
  }, [isVisible, pdfDoc, pageNum, scale, rotation, skipZones, registerPageTokens]); // Add rotation to dep array

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