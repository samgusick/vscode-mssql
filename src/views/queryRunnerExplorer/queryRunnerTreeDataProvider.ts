/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";

export type QueryRunnerStepStatus = "Running" | "Success" | "Error";

export interface QueryRunnerStep {
    name: string;
    status: QueryRunnerStepStatus;
    timestamp: string;
    message?: string;
}

export interface QueryRunnerInfo {
    id: string;
    status: string;
    query: string;
    duration: number;
    error?: string;
    steps: QueryRunnerStep[];
}

export class QueryRunnerTreeItem extends vscode.TreeItem {
    constructor(
        public readonly info: QueryRunnerInfo | QueryRunnerStep,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly parent?: QueryRunnerTreeItem,
    ) {
        super("name" in info ? info.name : info.query, collapsibleState);
        if ("status" in info && "query" in info) {
            // Parent (QueryRunnerInfo)
            this.description = `${info.status} (${info.duration}ms)`;
            this.tooltip = info.error ? `Error: ${info.error}` : undefined;
            this.contextValue = "queryRunner";
            this.iconPath = new vscode.ThemeIcon(
                info.status === "Running"
                    ? "sync~spin"
                    : info.status === "Success"
                      ? "check"
                      : "error",
            );
        } else {
            // Child (QueryRunnerStep)
            this.description = `${info.status} @ ${info.timestamp}`;
            this.tooltip = info.message;
            this.contextValue = "queryRunnerStep";
            this.iconPath = new vscode.ThemeIcon(
                info.status === "Running"
                    ? "sync~spin"
                    : info.status === "Success"
                      ? "check"
                      : "error",
            );
        }
    }
}

export class QueryRunnerTreeDataProvider implements vscode.TreeDataProvider<QueryRunnerTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<QueryRunnerTreeItem | undefined | void> =
        new vscode.EventEmitter<QueryRunnerTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<QueryRunnerTreeItem | undefined | void> =
        this._onDidChangeTreeData.event;

    private _queryRunners: QueryRunnerInfo[] = [];

    refresh(queryRunners: QueryRunnerInfo[]): void {
        this._queryRunners = queryRunners;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: QueryRunnerTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: QueryRunnerTreeItem): Thenable<QueryRunnerTreeItem[]> {
        if (!element) {
            // Top-level: all query runners
            return Promise.resolve(
                this._queryRunners.map(
                    (info) =>
                        new QueryRunnerTreeItem(
                            info,
                            info.steps.length > 0
                                ? vscode.TreeItemCollapsibleState.Collapsed
                                : vscode.TreeItemCollapsibleState.None,
                        ),
                ),
            );
        } else if ("status" in element.info && "query" in element.info) {
            // Children: steps for a query runner
            const runner = element.info as QueryRunnerInfo;
            return Promise.resolve(
                runner.steps.map(
                    (step) =>
                        new QueryRunnerTreeItem(
                            step,
                            vscode.TreeItemCollapsibleState.None,
                            element,
                        ),
                ),
            );
        }
        return Promise.resolve([]);
    }
}
