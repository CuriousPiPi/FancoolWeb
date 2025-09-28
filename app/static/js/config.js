export const APP_CONFIG = (() => {
  const injected = (window.APP_CONFIG) || {};
  return {
    clickCooldownMs: injected.clickCooldownMs ?? 2000,
    maxItems: injected.maxItems ?? 8
  };
})();