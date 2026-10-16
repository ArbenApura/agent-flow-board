// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { ModeChoice } from '#lib/theme/mode.js';

declare global {
	namespace App {
		interface Locals {
			modeChoice: ModeChoice;
			paletteStyle: string;
			/** The signed in person, or null. Set for every request by the authentication hook. */
			user: {
				id: string;
				name: string;
				email: string;
				emailVerified: boolean;
				image?: string | null;
			} | null;
			session: { id: string; token: string; expiresAt: Date } | null;
		}
	}
}

export {};
