/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { QueryRunnerTreeDataProvider } from "./queryRunnerTreeDataProvider";
import { QueryRunnerManager } from "../../controllers/queryRunnerManager";

export function registerQueryRunnerExplorer(context: vscode.ExtensionContext) {
    const provider = new QueryRunnerTreeDataProvider();
    const manager = QueryRunnerManager.getInstance();

    // Initial load
    provider.refresh(manager.getAll());

    // Listen for changes
    manager.onDidChange(() => {
        provider.refresh(manager.getAll());
    });

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("queryRunnerExplorer", provider),
    );
}
