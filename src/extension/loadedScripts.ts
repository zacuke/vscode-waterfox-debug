import * as vscode from 'vscode';
import { ThreadStartedEventBody, NewSourceEventBody } from "./main";

export class LoadedScriptsProvider implements vscode.TreeDataProvider<SourceTreeItem> {

	private readonly root = new RootTreeItem();

	private readonly treeDataChanged = new vscode.EventEmitter<SourceTreeItem>();
	public readonly onDidChangeTreeData: vscode.Event<SourceTreeItem>;

	public constructor() {
		this.onDidChangeTreeData = this.treeDataChanged.event;
	}

	public getTreeItem(node: SourceTreeItem): SourceTreeItem {
		return node;
	}

	public getChildren(node?: SourceTreeItem): vscode.ProviderResult<SourceTreeItem[]> {
		let parent = (node || this.root);
		return parent.getChildren();
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

	public removeThreads(sessionId: string) {
		let changedItem = this.root.removeThreads(sessionId);
		this.sendTreeDataChangedEvent(changedItem);
	}

	private sendTreeDataChangedEvent(changedItem: SourceTreeItem | undefined) {
		if (changedItem) {
			if (changedItem === this.root) {
				this.treeDataChanged.fire();
			} else {
				this.treeDataChanged.fire(changedItem);
			}
		}
	}
}

abstract class SourceTreeItem extends vscode.TreeItem {

	public constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed) {
		super(label, collapsibleState);
	}

	public abstract getChildren(): SourceTreeItem[];
}

class RootTreeItem extends SourceTreeItem {

	private children: ThreadTreeItem[] = [];
	private showThreads = false;

	public constructor() {
		super('');
	}

	public getChildren(): SourceTreeItem[] {

		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;

		if (this.showThreads || this.children.length > 1) {

			this.showThreads = true;
			return this.children;

		} else if (this.children.length == 1) {

			return this.children[0].getChildren();

		} else {
			return [];
		}
	}

	public addThread(
		threadInfo: ThreadStartedEventBody,
		sessionId: string
	): SourceTreeItem | undefined {

		if (!this.children.some((child) => (child.threadId === threadInfo.id))) {

			let index = this.children.findIndex((child) => (child.label > threadInfo.name));
			if (index < 0) index = this.children.length;

			this.children.splice(index, 0, new ThreadTreeItem(threadInfo, sessionId));

			return this;

		} else {
			return undefined;
		}
	}

	public removeThread(
		threadId: number,
		sessionId: string
	): SourceTreeItem | undefined {

		this.children = this.children.filter(
			(child) => ((child.sessionId !== sessionId) || (child.threadId !== threadId))
		);

		return this;
	}

	public addSource(
		sourceInfo: NewSourceEventBody,
		sessionId: string
	): SourceTreeItem | undefined {

		if (!sourceInfo.url) return undefined;

		let threadItem = this.children.find(
			(child) => ((child.sessionId === sessionId) && (child.threadId === sourceInfo.threadId))
		);

		if (threadItem) {

			let path = sourceInfo.url.split('/');
			let filename = path.pop()!;

			return threadItem.addSource(filename, path, sourceInfo, sessionId);

		} else {
			return undefined;
		}
	}

	public removeSources(
		threadId: number,
		sessionId: string
	): SourceTreeItem | undefined {

		let threadItem = this.children.find(
			(child) => ((child.sessionId === sessionId) && (child.threadId === threadId))
		);

		if (threadItem) {
			return threadItem.removeSources();
		} else {
			return undefined;
		}
	}

	public removeThreads(
		sessionId: string
	): SourceTreeItem | undefined {

		this.children = this.children.filter((child) => (child.sessionId !== sessionId));

		return this;
	}
}

abstract class NonLeafSourceTreeItem extends SourceTreeItem {

	protected children: (SourceDirectoryTreeItem | SourceFileTreeItem)[] = [];

	public constructor(label: string) {
		super(label);
	}

	public addSource(
		filename: string,
		path: string[],
		sourceInfo: NewSourceEventBody,
		sessionId: string
	): SourceTreeItem | undefined {

		if (path.length === 0) {

			// add the source file to this directory (not a subdirectory)
			this.addChild(new SourceFileTreeItem(filename, sourceInfo, sessionId));
			return this;

		}

		// find the index (if it exists) of the child directory item whose path starts
		// with the same directory name as the path to be added
		let itemIndex = this.children.findIndex(
			(item) => ((item instanceof SourceDirectoryTreeItem) && (item.path[0] === path[0]))
		);

		if (itemIndex < 0) {

			// there is no subdirectory that shares an initial path segment with the path to be added,
			// so we create a SourceDirectoryTreeItem for the path and add the source file to it
			let directoryItem = new SourceDirectoryTreeItem(path);
			directoryItem.addSource(filename, [], sourceInfo, sessionId);
			this.addChild(directoryItem);
			return this;

		}

		// the subdirectory item that shares an initial path segment with the path to be added
		let item = <SourceDirectoryTreeItem>this.children[itemIndex];

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
		return this;

	}

	public getChildren(): SourceTreeItem[] {
		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		return this.children;
	}

	/**
	 * add a child item, respecting the sort order
	 */
	private addChild(newChild: SourceDirectoryTreeItem | SourceFileTreeItem): void {

		let index: number;

		if (newChild instanceof SourceDirectoryTreeItem) {
			index = this.children.findIndex(
				(child) => !((child instanceof SourceDirectoryTreeItem) && (child.label <= newChild.label))
			);
		} else {
			index = this.children.findIndex(
				(child) => (child instanceof SourceFileTreeItem) && (child.label > newChild.label)
			);
		}

		if (index < 0) index = this.children.length;

		this.children.splice(index, 0, newChild);
	}
}

class ThreadTreeItem extends NonLeafSourceTreeItem {

	public readonly threadId: number;

	public constructor(
		threadInfo: ThreadStartedEventBody,
		public readonly sessionId: string
	) {
		super(threadInfo.name);
		this.threadId = threadInfo.id;
	}

	public removeSources(): SourceTreeItem | undefined {
		this.children = [];
		return this;
	}
}

class SourceDirectoryTreeItem extends NonLeafSourceTreeItem {

	public constructor(public path: string[]) {
		super(path.join('/'));
	}

	/**
	 * split this item into two items with this item representing the initial path segment of length
	 * `atIndex` and the new child item representing the rest of the path
	 */
	public split(atIndex: number): void {

		let newChild = new SourceDirectoryTreeItem(this.path.slice(atIndex));
		newChild.children = this.children;

		this.path.splice(atIndex);
		this.children = [ newChild ];
		this.label = this.path.join('/');
	}
}

class SourceFileTreeItem extends SourceTreeItem {

	public constructor(
		filename: string,
		sourceInfo: NewSourceEventBody,
		sessionId: string
	) {
		super(filename, vscode.TreeItemCollapsibleState.None);

		if (sourceInfo.path) {

			this.command = {
				command: 'extension.firefox.openLocalScript',
				arguments: [ sourceInfo.path, sessionId ],
				title: ''
			}

		} else {

			this.command = {
				command: 'extension.firefox.openRemoteScript',
				arguments: [ filename, sourceInfo.sourceId, sessionId ],
				title: ''
			}
		}
	}

	public getChildren(): SourceTreeItem[] {
		return [];
	}
}
