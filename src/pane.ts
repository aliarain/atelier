import type {ModApi} from '@commandcode/harness';

type PaneNode = ReturnType<Parameters<ModApi['ui']['pane']>[0]['render']>[number];

interface StatusElement {
	readonly type: 'status';
	readonly state: 'idle' | 'running' | 'done' | 'error';
	readonly text: string;
}

// Hosts that predate the status element do not list it, and would draw nothing for it.
export interface ElementCapabilities {
	readonly capabilities?: {readonly elements?: readonly string[]};
}

export function supportsStatus(ui: ElementCapabilities): boolean {
	return ui.capabilities?.elements?.includes('status') === true;
}

function statusLine(busy: readonly string[], hasStatus: boolean): PaneNode {
	if (!hasStatus) {
		return {type: 'text', text: busy.length > 0 ? `Making: ${busy.join(', ')}` : 'Ready', bold: true};
	}
	const element: StatusElement =
		busy.length > 0
			? {type: 'status', state: 'running', text: `Making ${busy.join(', ')}`}
			: {type: 'status', state: 'idle', text: 'Ready'};
	// The harness node union does not list `status` until the host ships it.
	return element as unknown as PaneNode;
}

export function paneNodes(params: {
	readonly busy: readonly string[];
	readonly hasStatus: boolean;
	readonly onOpenGallery: () => Promise<void>;
}): readonly PaneNode[] {
	const {busy, hasStatus, onOpenGallery} = params;
	return [
		statusLine(busy, hasStatus),
		{
			type: 'row',
			children: [{type: 'button', label: 'Open gallery', hotkey: 'g', onPress: onOpenGallery}],
		},
	];
}
