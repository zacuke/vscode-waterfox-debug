import * as vscode from 'vscode';
import { ThreadStartedEventBody, NewSourceEventBody } from "./main";

export class LoadedScriptsProvider implements vscode.TreeDataProvider<TreeNode> {

	private readonly root = new RootNode();

	private readonly treeDataChanged = new vscode.EventEmitter<TreeNode>();
	public readonly onDidChangeTreeData: vscode.Event<TreeNode>;

	public constructor() {
		this.onDidChangeTreeData = this.treeDataChanged.event;
	}

	public getTreeItem(node: TreeNode): vscode.TreeItem {
		return node.treeItem;
	}

	public getChildren(node?: TreeNode): vscode.ProviderResult<TreeNode[]> {
		let parent = (node || this.root);
		return parent.getChildren();
	}

	public addSession(session: vscode.DebugSession) {
		let changedItem = this.root.addSession(session);
		this.sendTreeDataChangedEvent(changedItem);
	}

	public removeSession(sessionId: string) {
		let changedItem = this.root.removeSession(sessionId);
		this.sendTreeDataChangedEvent(changedItem);
	}

	public addThread(threadInfo: ThreadStartedEventBody, sessionId: string) {
		let changedItem = this.root.addThread(threadInfo, sessionId);
		this.sendTreeDataChangedEvent(changedItem);
	}

	public removeThread(threadId: number, sessionId: string) {
		let changedItem = this.root.removeThread(threadId, sessionId);
		this.sendTreeDataChangedEvent(changedItem);
	}

	public addSource(sourceInfo: NewSourceEventBody, sessionId: string) {
		let changedItem = this.root.addSource(sourceInfo, sessionId);
		this.sendTreeDataChangedEvent(changedItem);
	}

	public removeSources(threadId: number, sessionId: string) {
		let changedItem = this.root.removeSources(threadId, sessionId);
		this.sendTreeDataChangedEvent(changedItem);
	}

	private sendTreeDataChangedEvent(changedItem: TreeNode | undefined) {
		if (changedItem) {
			if (changedItem === this.root) {
				this.treeDataChanged.fire();
			} else {
				this.treeDataChanged.fire(changedItem);
			}
		}
	}
}

export abstract class TreeNode {

	public readonly treeItem: vscode.TreeItem;

	public constructor(
		label: string,
		public parent?: TreeNode,
		collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed
	) {
		this.treeItem = new vscode.TreeItem(label, collapsibleState);
	}

	public getFullPath(): string {
		return '';
	}

	public abstract getChildren(): TreeNode[];
}

class RootNode extends TreeNode {

	private children: SessionNode[] = [];
	private showSessions = false;

	public constructor() {
		super('');
		this.treeItem.contextValue = 'root';
	}

	public addSession(session: SessionInfo): TreeNode | undefined {

		if (!this.children.some((child) => (child.id === session.id))) {

			let index = this.children.findIndex((child) => (child.treeItem.label > session.name));
			if (index < 0) index = this.children.length;

			this.children.splice(index, 0, new SessionNode(session, this));

			return this;

		} else {
			return undefined;
		}
	}

	public removeSession(sessionId: string): TreeNode | undefined {

		this.children = this.children.filter((child) => (child.id !== sessionId));
		return this;

	}

	public addThread(
		threadInfo: ThreadStartedEventBody,
		sessionId: string
	): TreeNode | undefined {

		let sessionItem = this.children.find((child) => (child.id === sessionId));
		return sessionItem ? this.fixChangedItem(sessionItem.addThread(threadInfo)) : undefined;

	}

	public removeThread(
		threadId: number,
		sessionId: string
	): TreeNode | undefined {

		let sessionItem = this.children.find((child) => (child.id === sessionId));
		return sessionItem ? this.fixChangedItem(sessionItem.removeThread(threadId)) : undefined;

	}

	public addSource(
		sourceInfo: NewSourceEventBody,
		sessionId: string
	): TreeNode | undefined {

		let sessionItem = this.children.find((child) => (child.id === sessionId));
		return sessionItem ? this.fixChangedItem(sessionItem.addSource(sourceInfo)) : undefined;

	}

	public removeSources(threadId: number, sessionId: string): TreeNode | undefined {

		let sessionItem = this.children.find((child) => (child.id === sessionId));
		return sessionItem ? this.fixChangedItem(sessionItem.removeSources(threadId)) : undefined;

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

interface SessionInfo {
	id: string;
	type: string;
	name: string;
}

class SessionNode extends TreeNode {

	protected children: ThreadNode[] = [];
	private showThreads = false;
	
	public get id() {
		return this.session.id;
	}

	public constructor(private session: SessionInfo, parent: RootNode) {
		super(session.name, parent);
		this.treeItem.contextValue = 'session';
	}

	public addThread(threadInfo: ThreadStartedEventBody): TreeNode | undefined {

		if (!this.children.some((child) => (child.id === threadInfo.id))) {

			let index = this.children.findIndex((child) => (child.treeItem.label > threadInfo.name));
			if (index < 0) index = this.children.length;

			this.children.splice(index, 0, new ThreadNode(threadInfo, this));

			return this;

		} else {
			return undefined;
		}
	}

	public removeThread(threadId: number): TreeNode | undefined {

		this.children = this.children.filter((child) => (child.id !== threadId));

		return this;
	}

	public addSource(sourceInfo: NewSourceEventBody): TreeNode | undefined {

		if (!sourceInfo.url) return undefined;

		let threadItem = this.children.find((child) => (child.id === sourceInfo.threadId));

		if (threadItem) {

			let path = splitURL(sourceInfo.url);
			let filename = path.pop()!;

			return this.fixChangedItem(threadItem.addSource(filename, path, sourceInfo, this.id));

		} else {
			return undefined;
		}
	}

	public removeSources(threadId: number): TreeNode | undefined {

		let threadItem = this.children.find((child) => (child.id === threadId));
		return threadItem ? threadItem.removeSources() : undefined;

	}

	public getChildren(): TreeNode[] {

		this.treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;

		if (this.showThreads || (this.children.length > 1)) {

			this.showThreads = true;
			return this.children;

		} else if (this.children.length == 1) {

			return this.children[0].getChildren();

		} else {
			return [];
		}
	}

	private fixChangedItem(changedItem: TreeNode | undefined): TreeNode | undefined {

		if (!changedItem) return undefined;

		if (!this.showThreads && (changedItem instanceof ThreadNode)) {
			return this;
		} else {
			return changedItem;
		}
	}
}

abstract class NonLeafNode extends TreeNode {

	protected children: (DirectoryNode | FileNode)[] = [];

	public constructor(label: string, parent: TreeNode) {
		super(label, parent);
	}

	public addSource(
		filename: string,
		path: string[],
		sourceInfo: NewSourceEventBody,
		sessionId: string
	): TreeNode | undefined {

		if (path.length === 0) {

			// add the source file to this directory (not a subdirectory)
			this.addChild(new FileNode(filename, sourceInfo, this, sessionId));
			return this;

		}

		// find the index (if it exists) of the child directory item whose path starts
		// with the same directory name as the path to be added
		let itemIndex = this.children.findIndex(
			(item) => ((item instanceof DirectoryNode) && (item.path[0] === path[0]))
		);

		if (itemIndex < 0) {

			// there is no subdirectory that shares an initial path segment with the path to be added,
			// so we create a SourceDirectoryTreeItem for the path and add the source file to it
			let directoryItem = new DirectoryNode(path, this);
			directoryItem.addSource(filename, [], sourceInfo, sessionId);
			this.addChild(directoryItem);
			return this;

		}

		// the subdirectory item that shares an initial path segment with the path to be added
		let item = <DirectoryNode>this.children[itemIndex];

		// the length of the initial path segment that is equal
		let pathMatchLength = path.findIndex(
			(pathElement, index) => ((index >= item.path.length) || (item.path[index] !== pathElement))
		);
		if (pathMatchLength < 0) pathMatchLength = path.length;

		// the unmatched end segment of the path
		let pathRest = path.slice(pathMatchLength);

		if (pathMatchLength === item.path.length) {

			// the entire path of the subdirectory item is contained in the path of the file to be
			// added, so we add the file with the pathRest to the subdirectory item
			return item.addSource(filename, pathRest, sourceInfo, sessionId);

		}

		// only a part of the path of the subdirectory item is contained in the path of the file to
		// be added, so we split the subdirectory item into two and add the file to the first item
		item.split(pathMatchLength);
		item.addSource(filename, pathRest, sourceInfo, sessionId);
		return item;

	}

	public getChildren(): TreeNode[] {
		this.treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		return this.children;
	}

	/**
	 * add a child item, respecting the sort order
	 */
	private addChild(newChild: DirectoryNode | FileNode): void {

		let index: number;

		if (newChild instanceof DirectoryNode) {
			index = this.children.findIndex(
				(child) => !((child instanceof DirectoryNode) && 
							 (child.treeItem.label < newChild.treeItem.label))
			);
		} else {
			index = this.children.findIndex(
				(child) => ((child instanceof FileNode) &&
							(child.treeItem.label >= newChild.treeItem.label))
			);
		}

		if (index >= 0) {

			if (this.children[index].treeItem.label !== newChild.treeItem.label) {
				this.children.splice(index, 0, newChild);
			}

		} else {

			this.children.push(newChild);

		}
	}
}

class ThreadNode extends NonLeafNode {

	public readonly id: number;

	public constructor(threadInfo: ThreadStartedEventBody, parent: SessionNode) {
		super(threadInfo.name, parent);
		this.id = threadInfo.id;
		this.treeItem.contextValue = 'thread';
	}

	public removeSources(): TreeNode | undefined {
		this.children = [];
		return this;
	}
}

class DirectoryNode extends NonLeafNode {

	public constructor(public path: string[], parent: TreeNode) {
		super(path.join('/'), parent);
		this.treeItem.contextValue = 'directory';
	}

	/**
	 * split this item into two items with this item representing the initial path segment of length
	 * `atIndex` and the new child item representing the rest of the path
	 */
	public split(atIndex: number): void {

		let newChild = new DirectoryNode(this.path.slice(atIndex), this);
		newChild.children = this.children;
		newChild.children.map(grandChild => grandChild.parent = newChild);

		this.path.splice(atIndex);
		this.children = [ newChild ];
		this.treeItem.label = this.path.join('/');
	}

	public getFullPath(): string {
		return this.parent!.getFullPath() + this.treeItem.label + '/';
	}
}

class FileNode extends TreeNode {

	public constructor(
		filename: string,
		sourceInfo: NewSourceEventBody,
		parent: NonLeafNode,
		sessionId: string
	) {
		super((filename.length > 0) ? filename : '(index)', parent, vscode.TreeItemCollapsibleState.None);
		this.treeItem.contextValue = 'file';

		let pathOrUri: string;
		if (sourceInfo.path) {
			pathOrUri = sourceInfo.path;
		} else {
			pathOrUri = `debug:${encodeURIComponent(sourceInfo.url!)}?session=${encodeURIComponent(sessionId)}&ref=${sourceInfo.sourceId}`;
		}

		this.treeItem.command = {
			command: 'extension.firefox.openScript',
			arguments: [ pathOrUri ],
			title: ''
		}
	}

	public getChildren(): TreeNode[] {
		return [];
	}

	public getFullPath(): string {
		return this.parent!.getFullPath() + this.treeItem.label;
	}
}

/**
 * Split a URL with '/' as the separator, without splitting the origin or the search portion
 */
function splitURL(urlString: string): string[] {

	let originLength: number;
	let i = urlString.indexOf(':');
	if (i >= 0) {
		i++;
		if (urlString[i] === '/') i++;
		if (urlString[i] === '/') i++;
		originLength = urlString.indexOf('/', i);
	} else {
		originLength = 0;
	}

	let searchStartIndex = urlString.indexOf('?', originLength);
	if (searchStartIndex < 0) {
		searchStartIndex = urlString.length;
	}

	let origin = urlString.substr(0, originLength);
	let search = urlString.substr(searchStartIndex);
	let path = urlString.substring(originLength, searchStartIndex);

	let result = path.split('/');
	result[0] = origin + result[0];
	result[result.length - 1] += search;

	return result;
}
