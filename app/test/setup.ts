// jsdom has no ResizeObserver; Radix components (the checkbox, popper content) measure themselves with it.
if (typeof window !== 'undefined' && typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
