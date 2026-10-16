// EMAIL TEMPLATES: ONE SHARED LAYOUT, PLAIN WORDS, ONE BUTTON PER MAIL

// -- TYPES -- //
import type { Mail } from './mailer';
// -- MODULES -- //
import { EMAIL_COLOURS as C } from '../../theme/email';

// -- FUNCTIONS -- //

const esc = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
	);

function layout(
	title: string,
	paragraphs: string[],
	action?: { label: string; url: string },
	footer?: string
): { html: string; text: string } {
	const body = paragraphs
		.map(
			(p) =>
				`<p style="margin:0 0 14px;font-size:14px;line-height:22px;color:${C.ink}">${esc(p)}</p>`
		)
		.join('');
	const button = action
		? `<p style="margin:20px 0"><a href="${esc(action.url)}" style="display:inline-block;background:${C.accent};color:${C.accentInk};text-decoration:none;font-weight:600;font-size:14px;line-height:20px;padding:12px 20px;border-radius:8px">${esc(action.label)}</a></p><p style="margin:0 0 14px;font-size:12px;line-height:18px;color:${C.muted}">Or paste this link into your browser: ${esc(action.url)}</p>`
		: '';
	const html = `<!doctype html><html><body style="margin:0;background:${C.page};font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:${C.surface};border:1px solid ${C.line};border-radius:12px"><tr><td style="padding:24px"><p style="margin:0 0 16px;font-size:14px;font-weight:700;color:${C.accent}">Agent Flow Board</p><h1 style="margin:0 0 14px;font-size:20px;line-height:28px;color:${C.ink}">${esc(title)}</h1>${body}${button}<p style="margin:16px 0 0;font-size:12px;line-height:18px;color:${C.muted}">${esc(footer ?? 'If you did not expect this email, you can ignore it.')}</p></td></tr></table></td></tr></table></body></html>`;
	const text = [
		title,
		'',
		...paragraphs,
		...(action ? ['', `${action.label}: ${action.url}`] : []),
		'',
		footer ?? 'If you did not expect this email, you can ignore it.'
	].join('\n');
	return { html, text };
}

export function verifyEmailMail(to: string, name: string, url: string): Mail {
	const { html, text } = layout(
		'Confirm your email address',
		[
			`Hi ${name}, confirm that this is your email address to finish creating your account.`,
			'The link works for one hour.'
		],
		{ label: 'Confirm email', url }
	);
	return { to, subject: 'Confirm your email address', html, text, tag: 'verify' };
}

export function resetPasswordMail(to: string, name: string, url: string): Mail {
	const { html, text } = layout(
		'Reset your password',
		[
			`Hi ${name}, someone asked to reset the password for this account.`,
			'The link works for one hour. Your old password keeps working until you set a new one.'
		],
		{ label: 'Choose a new password', url }
	);
	return { to, subject: 'Reset your password', html, text, tag: 'reset' };
}

export function inviteMail(
	to: string,
	orgName: string,
	inviter: string,
	role: string,
	url: string
): Mail {
	const { html, text } = layout(
		`Join ${orgName}`,
		[
			`${inviter} invited you to ${orgName} as ${role}.`,
			`The invitation is for ${to} only and works for 7 days.`
		],
		{ label: 'Accept invitation', url }
	);
	return { to, subject: `${inviter} invited you to ${orgName}`, html, text, tag: 'invite' };
}

export function newDeviceMail(to: string, name: string, device: string, when: string): Mail {
	const { html, text } = layout(
		'New sign in to your account',
		[
			`Hi ${name}, your account was signed in from a device we have not seen before.`,
			`Device: ${device}`,
			`Time: ${when}`,
			'If this was you, no action is needed. If not, reset your password now and sign out other sessions.'
		],
		undefined,
		'You get this email because new devices and tools always trigger an alert.'
	);
	return { to, subject: 'New sign in to your account', html, text, tag: 'new-device' };
}
