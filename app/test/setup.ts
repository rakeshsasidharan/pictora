// jsdom has no ResizeObserver; Radix components (the checkbox, popper content) measure themselves with it.
if (typeof window !== 'undefined' && typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom has no scrolling or pointer capture; the generate thread scrolls new turns into view, and Radix's select
// checks pointer capture when it opens.
if (typeof window !== 'undefined') {
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= function releasePointerCapture() {};
}
