import * as vscode from 'vscode';

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
