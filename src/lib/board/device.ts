// A READABLE NAME AND KIND FOR A SIGN-IN SESSION, FROM ITS USER AGENT. THE RAW STRING IS LONG, SO A PERSON READS "Chrome on Windows" INSTEAD

// -- TYPES -- //

export type DeviceKind = 'desktop' | 'phone' | 'tablet';
export type Device = { kind: DeviceKind; name: string };

// -- CONSTANTS -- //

// Order matters: Edge and Opera also say Chrome, and Chrome also says Safari
const BROWSERS: [RegExp, string][] = [
	[/Edg(?:e|A|iOS)?\//, 'Edge'],
	[/OPR\/|Opera/, 'Opera'],
	[/Firefox\/|FxiOS\//, 'Firefox'],
	[/Chrome\/|CriOS\//, 'Chrome'],
	[/Safari\//, 'Safari']
];
// The tablet and phone systems come before the desktop ones they borrow words from
const SYSTEMS: [RegExp, string][] = [
	[/iPad/, 'iPad'],
	[/iPhone|iPod/, 'iPhone'],
	[/Android/, 'Android'],
	[/Windows/, 'Windows'],
	[/Mac OS X|Macintosh/, 'macOS'],
	[/CrOS/, 'ChromeOS'],
	[/Linux|X11/, 'Linux']
];

// -- FUNCTIONS -- //

/** The kind and a short name for a user agent. An empty or unknown one is "A browser". */
export function parseDevice(userAgent: string | null | undefined): Device {
	const ua = (userAgent ?? '').trim();
	if (!ua) return { kind: 'desktop', name: 'A browser' };

	const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
	const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
	const tablet = system === 'iPad' || (system === 'Android' && !/Mobile/.test(ua));
	const phone = system === 'iPhone' || (system === 'Android' && /Mobile/.test(ua));
	const kind: DeviceKind = tablet ? 'tablet' : phone ? 'phone' : 'desktop';

	if (browser && system) return { kind, name: `${browser} on ${system}` };
	if (browser) return { kind, name: browser };
	// A tool such as the CLI names itself in the first product token
	const first = ua.split(/[\s/]/)[0];
	return { kind, name: first && first.length <= 40 ? first : 'A browser' };
}
