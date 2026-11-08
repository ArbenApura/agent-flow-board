// PLAIN WORDS FOR THE VERBS THE ACTIVITY LOG RECORDS

// -- CONSTANTS -- //

const TEXT: Record<string, string> = {
	'item.create': 'created the item',
	'item.update': 'changed the item',
	'item.status': 'changed the status',
	'item.delete': 'moved the item to the trash',
	'item.restore': 'restored the item from the trash',
	'item.log': 'added a log line',
	'phase.create': 'added a phase',
	'step.create': 'added a step',
	'step.update': 'marked a step',
	'manual_check.create': 'added a manual check',
	'manual_check.update': 'marked a manual check',
	'decision.create': 'added a decision',
	'decision.update': 'changed a decision',
	'decision.delete': 'deleted a decision',
	'section.create': 'added a section',
	'section.update': 'edited a section',
	'comment.create': 'commented',
	'attachment.create': 'attached a file',
	'attachment.update': 'changed who can see a file',
	'attachment.delete': 'removed a file',
	'task.create': 'added a task',
	'task.update': 'changed a task',
	'task.delete': 'moved a task to the trash',
	'task.restore': 'restored a task from the trash',
	'project.create': 'created the project',
	'project.update': 'changed the project settings',
	'org.settings': 'changed the organisation settings',
	'github.link': 'connected a repository',
	'github.unlink': 'disconnected the repository',
	'github.settings': 'changed the publish settings',
	'publish.done': 'published to GitHub',
	'publish.failed': 'could not publish',
	'publish.refused': 'was refused by a public repository',
	'publish.cancel': 'cancelled a publish',
	'environment.save': 'saved an environment',
	'environment.delete': 'removed an environment',
	'secret.set': 'saved a test account',
	'secret.delete': 'removed a test account',
	'runner.create': 'registered a runner',
	'runner.approve': 'approved the sign in of a tool',
	'runner.update': 'changed the projects a runner serves',
	'runner.delete': 'removed a runner',
	'check.save': 'saved a browser check',
	'check.delete': 'removed a browser check',
	'check_run.request': 'asked for a browser check run',
	'check_run.finish': 'finished a browser check run',
	'check_run.reopen': 'reopened work after a browser check failed',
	'ui_change.save': 'pinned pages to the UI shots',
	'ui_shots.request': 'asked for a UI shots run',
	'ui_shots.finish': 'finished a UI shots run',
	'ui_scale.measure': 'measured the design scale'
};

// -- FUNCTIONS -- //

/** "created the item", or the raw verb when it has no words yet. */
export const verbText = (verb: string) => TEXT[verb] ?? verb.replace(/[._]/g, ' ');
