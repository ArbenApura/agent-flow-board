// THE CLIENT SIDE OF THE STALE WHILE REVALIDATE CACHE (ADR-020). THE CACHE ITSELF IS static/swr.js, WHICH MUST RUN BEFORE THE APP

// -- TYPES -- //
type Swr = {
	clear: () => void;
	size: () => number;
	onChange: (fn: () => void) => void;
};

// -- FUNCTIONS -- //

const swr = (): Swr | undefined => (window as unknown as { __afbSwr?: Swr }).__afbSwr;

export const clearCache = () => swr()?.clear();
export const cacheSize = () => swr()?.size() ?? 0;
/** `changed` runs when a background refresh brought different data, so the page can load it. */
export const installSwr = (changed: () => void) => swr()?.onChange(changed);
