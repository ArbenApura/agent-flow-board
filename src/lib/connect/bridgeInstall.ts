// THE WORDS OF INSTALLING AND SIGNING IN THE BRIDGE, ONE PLACE FOR THE CONNECT PAGE. PURE, SO A TEST CAN HOLD THEM TOGETHER WITH THE INSTALL PLAN THE SERVER HANDS AN AGENT.

// -- CONSTANTS -- //

/** The npm package of the local bridge. */
export const BRIDGE_PACKAGE = '@agent-flow-board/bridge';
/** The program the package installs. */
export const BRIDGE_PROGRAM = 'agent-flow-board';
/** Installed globally on purpose: the hooks call it several times per tool call, and a command started through npx each time is too slow. */
export const INSTALL_COMMAND = `npm install -g ${BRIDGE_PACKAGE}`;
export const NODE_REQUIREMENT = 'Node 20 or later';

// -- FUNCTIONS -- //

/** The plain command that signs the bridge in to one organisation, with a device code approved in the browser. */
export const loginCommand = (server: string, orgSlug: string) =>
	`${BRIDGE_PROGRAM} login --server ${server} --org ${orgSlug}`;
