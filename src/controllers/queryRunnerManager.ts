/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from "vscode";
import {
    QueryRunnerInfo,
    QueryRunnerStep,
} from "../views/queryRunnerExplorer/queryRunnerTreeDataProvider";

export class QueryRunnerManager {
    private static _instance: QueryRunnerManager;
    private _queryRunners: Map<string, QueryRunnerInfo> = new Map();
    private _onDidChange = new EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    private constructor() {}

    public static getInstance(): QueryRunnerManager {
        if (!QueryRunnerManager._instance) {
            QueryRunnerManager._instance = new QueryRunnerManager();
        }
        return QueryRunnerManager._instance;
    }

    public getAll(): QueryRunnerInfo[] {
        return Array.from(this._queryRunners.values());
    }

    public updateQueryRunner(info: QueryRunnerInfo) {
        this._queryRunners.set(info.id, info);
        this._onDidChange.fire();
    }

    public appendStep(id: string, step: QueryRunnerStep) {
        const runner = this._queryRunners.get(id);
        if (runner) {
            runner.steps = runner.steps ? [...runner.steps, step] : [step];
            this._onDidChange.fire();
        }
    }

    public removeQueryRunner(id: string) {
        this._queryRunners.delete(id);
        this._onDidChange.fire();
    }
}
