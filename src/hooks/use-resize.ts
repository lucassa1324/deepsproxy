import { useState, useEffect, useCallback, useRef } from 'react';

export interface ResizeObserverEntry {
  target: Element;
  contentRect: DOMRectReadOnly;
  borderBoxSize?: ResizeObserverSize[];
  contentBoxSize?: ResizeObserverSize[];
  devicePixelContentBoxSize?: ResizeObserverSize[];
}

export interface UseResizeOptions {
  box?: ResizeObserverBoxOptions;
  onResize?: (entry: ResizeObserverEntry) => void;
  enabled?: boolean;
}

export interface UseResizeReturn {
  ref: (node: Element | null) => void;
  width: number;
  height: number;
  entry: ResizeObserverEntry | null;
}

function log(label: string, data: unknown) {
  console.log(`[use-resize] ${label}`, data);
}

export function useResize(options: UseResizeOptions = {}): UseResizeReturn {
  const { box = 'content-box', onResize, enabled = true } = options;
  
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [entry, setEntry] = useState<ResizeObserverEntry | null>(null);
  const elementRef = useRef<Element | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const callbackRef = useRef(onResize);

  callbackRef.current = onResize;

  const setRef = useCallback((node: Element | null) => {
    log('setRef called', { node: node?.tagName, previous: elementRef.current?.tagName });
    
    if (elementRef.current && observerRef.current) {
      log('Unobserving previous element', elementRef.current);
      observerRef.current.unobserve(elementRef.current);
    }

    elementRef.current = node;

    if (node && observerRef.current && enabled) {
      log('Observing new element', node);
      observerRef.current.observe(node, { box });
    }
  }, [box, enabled]);

  useEffect(() => {
    log('Initializing ResizeObserver');
    
    observerRef.current = new ResizeObserver((entries) => {
      log('ResizeObserver callback', { entriesCount: entries.length });
      
      const latestEntry = entries[entries.length - 1];
      if (!latestEntry) return;

      const { contentRect } = latestEntry;
      const newWidth = contentRect.width;
      const newHeight = contentRect.height;

      log('Size changed', { width: newWidth, height: newHeight });

      setWidth(newWidth);
      setHeight(newHeight);
      setEntry(latestEntry);

      if (callbackRef.current) {
        log('Calling onResize callback');
        callbackRef.current(latestEntry);
      }
    });

    if (elementRef.current && enabled) {
      log('Observing initial element', elementRef.current);
      observerRef.current.observe(elementRef.current, { box });
    }

    return () => {
      log('Cleanup: disconnecting observer');
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [box, enabled]);

  useEffect(() => {
    if (!enabled && observerRef.current && elementRef.current) {
      log('Disabled: unobserving element');
      observerRef.current.unobserve(elementRef.current);
    } else if (enabled && observerRef.current && elementRef.current) {
      log('Enabled: observing element');
      observerRef.current.observe(elementRef.current, { box });
    }
  }, [enabled, box]);

  return { ref: setRef, width, height, entry };
}

export default useResize;