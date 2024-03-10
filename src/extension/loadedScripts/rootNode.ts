import * as vscode from 'vscode';
import { ThreadStartedEventBody, NewSourceEventBody } from '../../common/customEvents';
import { TreeNode } from './treeNode';
import { SessionNode } from './sessionNode';

interface PendingSession {
	promise: Promise<SessionNode>;
	resolve: (sessionNode: SessionNode) => void;
}

export class RootNode extends TreeNode {

	private children: SessionNode[] = [];
	private showSessions = false;
	private pendingSessions = new Map<string, PendingSession>();

	public constructor() {
		super('');
		this.treeItem.contextValue = 'root';
	}

	private async waitForSession(sessionId: string): Promise<SessionNode> {
		const sessionNode = this.children.find((child) => (child.id === sessionId));
		if (sessionNode) {
			return sessionNode;
		}
		let resolve!: (sessionNode: SessionNode) => void;
		const promise = new Promise<SessionNode>(r => resolve = r);
		this.pendingSessions.set(sessionId, { promise, resolve });
		return await promise;
	}

	public addSession(session: vscode.DebugSession): TreeNode | undefined {

		if (!this.children.some((child) => (child.id === session.id))) {

			let index = this.children.findIndex((child) => (child.treeItem.label! > session.name));
			if (index < 0) index = this.children.length;

			const sessionNode = new SessionNode(session, this);
			this.children.splice(index, 0, sessionNode);

			const pendingSession = this.pendingSessions.get(session.id);
			if (pendingSession) {
				pendingSession.resolve(sessionNode);
				this.pendingSessions.delete(session.id);
			}

			return this;

		} else {
			return undefined;
		}
	}

	public removeSession(sessionId: string): TreeNode | undefined {

		this.children = this.children.filter((child) => (child.id !== sessionId));
		return this;

	}

	public async addThread(
		threadInfo: ThreadStartedEventBody,
		sessionId: string
	): Promise<TreeNode | undefined> {

		const sessionNode = await this.waitForSession(sessionId);
		return this.fixChangedItem(sessionNode.addThread(threadInfo));

	}

	public removeThread(
		threadId: number,
		sessionId: string
	): TreeNode | undefined {

		let sessionItem = this.children.find((child) => (child.id === sessionId));
		return sessionItem ? this.fixChangedItem(sessionItem.removeThread(threadId)) : undefined;

	}

	public async addSource(
		sourceInfo: NewSourceEventBody,
		sessionId: string
	): Promise<TreeNode | undefined> {

		const sessionNode = await this.waitForSession(sessionId);
		return this.fixChangedItem(sessionNode.addSource(sourceInfo));

	}

	public removeSources(threadId: number, sessionId: string): TreeNode | undefined {

		let sessionItem = this.children.find((child) => (child.id === sessionId));
		return sessionItem ? this.fixChangedItem(sessionItem.removeSources(threadId)) : undefined;

	}

	public getSourceUrls(sessionId: string): string[] | undefined {

		const sessionNode = this.children.find(child => (child.id === sessionId));
		return sessionNode ? sessionNode.getSourceUrls() : undefined;

	}

	public getChildren(): TreeNode[] {

		this.treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;

		if (this.showSessions || (this.children.length > 1)) {

			this.showSessions = true;
			return this.children;

		} else if (this.children.length == 1) {

			return this.children[0].getChildren();

		} else {
			return [];
		}
	}

	private fixChangedItem(changedItem: TreeNode | undefined): TreeNode | undefined {

		if (!changedItem) return undefined;

		if (!this.showSessions && (changedItem instanceof SessionNode)) {
			return this;
		} else {
			return changedItem;
		}
	}
}
