// SIGN OUT WITH A TOAST: POSTS TO /sign-out, THEN GOES TO THE SIGN IN PAGE WITH THE TOAST STILL SHOWING

// IMPORTED ENVS
import { goto } from '$app/navigation';
// IMPORTED MODULES
import { toast } from './toast.svelte.js';

// -- CONSTANTS -- //

const FAILED = 'Could not sign you out. Try again.';

// -- STATES -- //

/** A second click while the first sign out is running does nothing. */
let running = false;

// -- FUNCTIONS -- //

/**
 * The submit handler of every sign out form. The forms keep `method="POST" action="/sign-out"`,
 * so without JavaScript they still work as a plain POST.
 */
export async function signOut(event: SubmitEvent) {
	event.preventDefault();
	if (running) return;
	running = true;
	const form = event.currentTarget as HTMLFormElement;
	// /sign-out answers with a redirect; anything else means the session was not ended
	const request = fetch(form.action, { method: 'POST', redirect: 'manual' }).then((res) => {
		if (res.type !== 'opaqueredirect' && !res.ok && !(res.status >= 300 && res.status < 400))
			throw new Error(FAILED);
	});
	try {
		await toast.promise(request, {
			id: 'sign-out',
			loading: 'Signing you out...',
			success: 'Signed out.',
			error: FAILED
		});
		await goto('/sign-in', { invalidateAll: true });
	} catch {
		// The error toast already shows the failure
	} finally {
		running = false;
	}
}
