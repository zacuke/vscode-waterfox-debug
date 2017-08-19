import * as vscode from 'vscode';
import { ThreadStartedEventBody, NewSourceEventBody } from "./main";

export class LoadedScriptsProvider implements vscode.TreeDataProvider<SourceTreeItem> {

	private readonly root: RootTreeItem;

	private readonly treeDataChanged = new vscode.EventEmitter<SourceTreeItem>();
	public readonly onDidChangeTreeData: vscode.Event<SourceTreeItem>;

	public constructor() {
		this.root = new RootTreeItem(this.treeDataChanged);
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
		this.root.addThread(threadInfo, sessionId);
	}

	public removeThread(threadId: number, sessionId: string) {
		this.root.removeThread(threadId, sessionId);
	}

	public addSource(sourceInfo: NewSourceEventBody, sessionId: string) {
		this.root.addSource(sourceInfo, sessionId);
	}

	public removeSources(threadId: number, sessionId: string) {
		this.root.removeSources(threadId, sessionId);
	}

	public removeThreads(sessionId: string) {
		this.root.removeThreads(sessionId);
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

	public constructor(private treeDataChanged: vscode.EventEmitter<SourceTreeItem>) {
		super('');
	}

	public getChildren(): SourceTreeItem[] {
		return this.children;
	}

	public addThread(threadInfo: ThreadStartedEventBody, sessionId: string) {

		if (!this.children.some((child) => (child.threadId === threadInfo.id))) {

			this.children.push(new ThreadTreeItem(this.treeDataChanged, threadInfo, sessionId));

			this.treeDataChanged.fire();
		}
	}

	public removeThread(threadId: number, sessionId: string) {

		this.children = this.children.filter(
			(child) => ((child.sessionId !== sessionId) || (child.threadId !== threadId))
		);

		this.treeDataChanged.fire();
	}

	public addSource(sourceInfo: NewSourceEventBody, sessionId: string) {

		if (!sourceInfo.url) return;

		let threadItem = this.children.find(
			(child) => ((child.sessionId === sessionId) && (child.threadId === sourceInfo.threadId))
		);

		if (threadItem) {

			let path = sourceInfo.url.split('/');
			let filename = path.pop()!;

			threadItem.addSource(filename, path);
		}
	}

	public removeSources(threadId: number, sessionId: string) {

		let threadItem = this.children.find(
			(child) => ((child.sessionId === sessionId) && (child.threadId === threadId))
		);

		if (threadItem) {
			threadItem.removeSources();
		}
	}

	public removeThreads(sessionId: string) {

		this.children = this.children.filter((child) => (child.sessionId !== sessionId));

		this.treeDataChanged.fire();
	}
}

abstract class NonLeafSourceTreeItem extends SourceTreeItem {

	protected children: (SourceDirectoryTreeItem | SourceFileTreeItem)[] = [];

	public constructor(
		protected treeDataChanged: vscode.EventEmitter<SourceTreeItem>,
		label: string
	) {
		super(label);
	}

	public addSource(filename: string, path: string[] = []): void {

		if (path.length === 0) {

			// add the source file to this directory (not a subdirectory)
			this.addChild(new SourceFileTreeItem(filename));
			this.treeDataChanged.fire(this);
			return;

		}

		// find the index (if it exists) of the child directory item whose path starts
		// with the same directory name as the path to be added
		let itemIndex = this.children.findIndex(
			(item) => ((item instanceof SourceDirectoryTreeItem) && (item.path[0] === path[0]))
		);

		if (itemIndex < 0) {

			// there is no subdirectory that shares an initial path segment with the path to be added,
			// so we create a SourceDirectoryTreeItem for the path and add the source file to it
			let directoryItem = new SourceDirectoryTreeItem(this.treeDataChanged, path);
			directoryItem.addSource(filename);
			this.addChild(directoryItem);
			this.treeDataChanged.fire(this);
			return;

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
			item.addSource(filename, pathRest);
			return;

		}

		// only a part of the path of the subdirectory item is contained in the path of the file to
		// be added, so we split the subdirectory item into two and add the file to the first item
		item.split(pathMatchLength);
		item.addSource(filename, pathRest);
		this.treeDataChanged.fire(this);

	}

	public getChildren(): SourceTreeItem[] {
		return this.children;
	}

	/**
	 * add a child item, respecting the sort order
	 */
	private addChild(newChild: SourceDirectoryTreeItem | SourceFileTreeItem) {

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
		treeDataChanged: vscode.EventEmitter<SourceTreeItem>,
		threadInfo: ThreadStartedEventBody,
		public readonly sessionId: string
	) {
		super(treeDataChanged, threadInfo.name);
		this.threadId = threadInfo.id;
	}

	public removeSources() {
		this.children = [];
		this.treeDataChanged.fire(this);
	}
}

class SourceDirectoryTreeItem extends NonLeafSourceTreeItem {

	public constructor(
		treeDataChanged: vscode.EventEmitter<SourceTreeItem>,
		public path: string[]
	) {
		super(treeDataChanged, path.join('/'));
	}

	/**
	 * split this item into two items with this item representing the initial path segment of length
	 * `atIndex` and the new child item representing the rest of the path
	 */
	public split(atIndex: number) {

		let newChild = new SourceDirectoryTreeItem(this.treeDataChanged, this.path.slice(atIndex));
		newChild.children = this.children;

		this.path.splice(atIndex);
		this.children = [ newChild ];
		this.label = this.path.join('/');

		this.treeDataChanged.fire(this);
	}
}

class SourceFileTreeItem extends SourceTreeItem {

	public constructor(filename: string) {
		super(filename, vscode.TreeItemCollapsibleState.None);
	}

	public getChildren(): SourceTreeItem[] {
		return [];
	}
}
