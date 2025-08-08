/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import * as qr from "../sharedInterfaces/queryResult";
import * as Constants from "../constants/constants";
import * as LocalizedConstants from "../constants/locConstants";
import { ReactWebviewViewController } from "../controllers/reactWebviewViewController";
import { SqlOutputContentProvider } from "../models/sqlOutputContentProvider";
import { sendActionEvent, sendErrorEvent } from "../telemetry/telemetry";
import { TelemetryActions, TelemetryViews } from "../sharedInterfaces/telemetry";
import { randomUUID } from "crypto";
import { ApiStatus } from "../sharedInterfaces/webview";
import UntitledSqlDocumentService from "../controllers/untitledSqlDocumentService";
import { ExecutionPlanService } from "../services/executionPlanService";
import VscodeWrapper from "../controllers/vscodeWrapper";
import { QueryResultWebviewPanelController } from "./queryResultWebviewPanelController";
import { getNewResultPaneViewColumn, registerCommonRequestHandlers } from "./utils";

export class QueryResultWebviewController extends ReactWebviewViewController<
    qr.QueryResultWebviewState,
    qr.QueryResultReducers
> {
    private _queryResultStateMap: Map<string, qr.QueryResultWebviewState> = new Map<
        string,
        qr.QueryResultWebviewState
    >();
    private _queryResultWebviewPanelControllerMap: Map<string, QueryResultWebviewPanelController> =
        new Map<string, QueryResultWebviewPanelController>();
    private _sqlOutputContentProviderMap: Map<string, SqlOutputContentProvider> = new Map<
        string,
        SqlOutputContentProvider
    >();
    private _correlationId: string = randomUUID();
    private _selectionSummaryStatusBarItem: vscode.StatusBarItem =
        vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 2);
    public actualPlanStatuses: string[] = [];

    // Restore old API for compatibility
    public setSqlOutputContentProvider(uri: string, provider: SqlOutputContentProvider): void {
        this._sqlOutputContentProviderMap.set(uri, provider);
    }

    public getSqlOutputContentProvider(uri: string): SqlOutputContentProvider | undefined {
        return this._sqlOutputContentProviderMap.get(uri);
    }

    public hasPanel(uri: string): boolean {
        return this._queryResultWebviewPanelControllerMap.has(uri);
    }

    public addResultSetSummary(uri: string, resultSet: any): void {
        const state = this._queryResultStateMap.get(uri);
        if (state) {
            if (!state.resultSetSummaries) {
                state.resultSetSummaries = {};
            }
            if (!state.resultSetSummaries[resultSet.batchId]) {
                state.resultSetSummaries[resultSet.batchId] = {};
            }
            state.resultSetSummaries[resultSet.batchId][resultSet.id] = resultSet;
            this._queryResultStateMap.set(uri, state);
        }
    }

    public removePanel(uri: string): void {
        this._queryResultWebviewPanelControllerMap.delete(uri);
    }

    public updateSelectionSummaryStatusItem(summary: string): void {
        this._selectionSummaryStatusBarItem.text = summary;
        this._selectionSummaryStatusBarItem.show();
    }

    public getNumExecutionPlanResultSets(
        resultSetSummaries: any,
        actualPlanEnabled: boolean,
    ): number {
        // Ported from old logic: count result sets with showplan xml column
        let count = 0;
        for (const batchId in resultSetSummaries) {
            for (const resultId in resultSetSummaries[batchId]) {
                const resultSet = resultSetSummaries[batchId][resultId];
                if (
                    resultSet &&
                    resultSet.columnInfo &&
                    resultSet.columnInfo[0]?.columnName === "Microsoft SQL Server 2005 XML Showplan"
                ) {
                    count++;
                }
            }
        }
        return count;
    }

    public getExecutionPlanService(): ExecutionPlanService {
        return this.executionPlanService;
    }

    public getUntitledDocumentService(): UntitledSqlDocumentService {
        return this.untitledSqlDocumentService;
    }

    public async copyAllMessagesToClipboard(uri: string): Promise<void> {
        const state = this._queryResultStateMap.get(uri);
        if (state && state.messages && state.messages.length > 0) {
            const text = state.messages.map((m) => m.message).join("\n");
            await vscode.env.clipboard.writeText(text);
        }
    }

    constructor(
        context: vscode.ExtensionContext,
        vscodeWrapper: VscodeWrapper,
        private executionPlanService: ExecutionPlanService,
        private untitledSqlDocumentService: UntitledSqlDocumentService,
    ) {
        super(context, vscodeWrapper, "queryResult", "queryResult", {
            resultSetSummaries: {},
            messages: [],
            tabStates: {
                resultPaneTab: qr.QueryResultPaneTabs.Messages,
            },
            executionPlanState: {},
            fontSettings: {},
        });

        void this.initialize();

        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                const uri = editor?.document?.uri?.toString(true);
                if (uri && this._queryResultStateMap.has(uri)) {
                    this.state = this.getQueryResultState(uri);
                } else {
                    this.state = {
                        resultSetSummaries: {},
                        messages: [],
                        tabStates: undefined,
                        isExecutionPlan: false,
                        executionPlanState: { loadState: ApiStatus.NotStarted },
                        fontSettings: {
                            fontSize: this.getFontSizeConfig(),
                            fontFamily: this.getFontFamilyConfig(),
                        },
                        autoSizeColumns: this.getAutoSizeColumnsConfig(),
                        inMemoryDataProcessingThreshold:
                            this.getInMemoryDataProcessingThresholdConfig(),
                    };
                }
            }),
        );

        // not the best api but it's the best we can do in VSCode
        context.subscriptions.push(
            this.vscodeWrapper.onDidOpenTextDocument((document) => {
                const uri = document.uri.toString(true);
                if (this._queryResultStateMap.has(uri)) {
                    this._queryResultStateMap.delete(uri);
                }
            }),
        );

        context.subscriptions.push(
            this.vscodeWrapper.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration("mssql.resultsFontFamily")) {
                    for (const [uri, state] of this._queryResultStateMap) {
                        state.fontSettings.fontFamily = this.vscodeWrapper
                            .getConfiguration(Constants.extensionName)
                            .get(Constants.extConfigResultKeys.ResultsFontFamily);
                        this._queryResultStateMap.set(uri, state);
                    }
                }
                if (e.affectsConfiguration("mssql.resultsFontSize")) {
                    for (const [uri, state] of this._queryResultStateMap) {
                        state.fontSettings.fontSize =
                            (this.vscodeWrapper
                                .getConfiguration(Constants.extensionName)
                                .get(Constants.extConfigResultKeys.ResultsFontSize) as number) ??
                            (this.vscodeWrapper
                                .getConfiguration("editor")
                                .get("fontSize") as number);
                        this._queryResultStateMap.set(uri, state);
                    }
                }
                if (e.affectsConfiguration("mssql.resultsGrid.autoSizeColumns")) {
                    for (const [uri, state] of this._queryResultStateMap) {
                        state.autoSizeColumns = this.getAutoSizeColumnsConfig();
                        this._queryResultStateMap.set(uri, state);
                    }
                }
                if (e.affectsConfiguration("mssql.resultsGrid.inMemoryDataProcessingThreshold")) {
                    for (const [uri, state] of this._queryResultStateMap) {
                        state.inMemoryDataProcessingThreshold = this.vscodeWrapper
                            .getConfiguration(Constants.extensionName)
                            .get(Constants.configInMemoryDataProcessingThreshold);
                        this._queryResultStateMap.set(uri, state);
                    }
                }
            }),
        );
    }

    private async initialize() {
        this.registerRpcHandlers();
    }

    private get isOpenQueryResultsInTabByDefaultEnabled(): boolean {
        return this.vscodeWrapper
            .getConfiguration()
            .get(Constants.configOpenQueryResultsInTabByDefault);
    }

    private get isDefaultQueryResultToDocumentDoNotShowPromptEnabled(): boolean {
        return this.vscodeWrapper
            .getConfiguration()
            .get(Constants.configOpenQueryResultsInTabByDefaultDoNotShowPrompt);
    }

    private get shouldShowDefaultQueryResultToDocumentPrompt(): boolean {
        return (
            !this.isOpenQueryResultsInTabByDefaultEnabled &&
            !this.isDefaultQueryResultToDocumentDoNotShowPromptEnabled
        );
    }

    private registerRpcHandlers() {
        this.onRequest(qr.OpenInNewTabRequest.type, async (message) => {
            void this.createPanelController(message.uri);

            if (this.shouldShowDefaultQueryResultToDocumentPrompt) {
                const response = await this.vscodeWrapper.showInformationMessage(
                    LocalizedConstants.openQueryResultsInTabByDefaultPrompt,
                    LocalizedConstants.alwaysShowInNewTab,
                    LocalizedConstants.keepInQueryPane,
                );
                let telemResponse: string;
                switch (response) {
                    case LocalizedConstants.alwaysShowInNewTab:
                        telemResponse = "alwaysShowInNewTab";
                        break;
                    case LocalizedConstants.keepInQueryPane:
                        telemResponse = "keepInQueryPane";
                        break;
                    default:
                        telemResponse = "dismissed";
                }

                sendActionEvent(
                    TelemetryViews.General,
                    TelemetryActions.OpenQueryResultsInTabByDefaultPrompt,
                    {
                        response: telemResponse,
                    },
                );

                if (response === LocalizedConstants.alwaysShowInNewTab) {
                    await this.vscodeWrapper
                        .getConfiguration()
                        .update(
                            Constants.configOpenQueryResultsInTabByDefault,
                            true,
                            vscode.ConfigurationTarget.Global,
                        );
                }
                // show the prompt only once
                await this.vscodeWrapper
                    .getConfiguration()
                    .update(
                        Constants.configOpenQueryResultsInTabByDefaultDoNotShowPrompt,
                        true,
                        vscode.ConfigurationTarget.Global,
                    );
            }
        });
        this.onRequest(qr.GetWebviewLocationRequest.type, async () => {
            return qr.QueryResultWebviewLocation.Panel;
        });
        this.onRequest(qr.ShowFilterDisabledMessageRequest.type, async () => {
            this.vscodeWrapper.showInformationMessage(
                LocalizedConstants.inMemoryDataProcessingThresholdExceeded,
            );
        });
        registerCommonRequestHandlers(this, this._correlationId);
    }

    public async createPanelController(uri: string) {
        const viewColumn = getNewResultPaneViewColumn(uri, this.vscodeWrapper);
        if (this._queryResultWebviewPanelControllerMap.has(uri)) {
            this._queryResultWebviewPanelControllerMap.get(uri).revealToForeground();
            return;
        }

        const controller = new QueryResultWebviewPanelController(
            this._context,
            this.vscodeWrapper,
            viewColumn,
            uri,
            this._queryResultStateMap.get(uri).title,
            this,
        );
        controller.state = this.getQueryResultState(uri);
        controller.revealToForeground();
        this._queryResultWebviewPanelControllerMap.set(uri, controller);
        if (this.isVisible()) {
            await vscode.commands.executeCommand("workbench.action.togglePanel");
        }
    }

    public addQueryResultState(
        uri: string,
        title: string,
        isExecutionPlan?: boolean,
        actualPlanEnabled?: boolean,
    ): void {
        let currentState = {
            resultSetSummaries: {},
            messages: [],
            tabStates: {
                resultPaneTab: qr.QueryResultPaneTabs.Messages,
            },
            uri: uri,
            title: title,
            isExecutionPlan: isExecutionPlan,
            actualPlanEnabled: actualPlanEnabled,
            executionPlanState: isExecutionPlan
                ? {
                      loadState: ApiStatus.Loading,
                      executionPlanGraphs: [],
                      totalCost: 0,
                      xmlPlans: {},
                  }
                : { loadState: ApiStatus.NotStarted },
            fontSettings: {
                fontSize: this.getFontSizeConfig(),
                fontFamily: this.getFontFamilyConfig(),
            },
            autoSizeColumns: this.getAutoSizeColumnsConfig(),
            inMemoryDataProcessingThreshold: this.getInMemoryDataProcessingThresholdConfig(),
        };
        this._queryResultStateMap.set(uri, currentState);
    }

    public getAutoSizeColumnsConfig(): boolean {
        return this.vscodeWrapper
            .getConfiguration(Constants.extensionName)
            .get(Constants.configAutoColumnSizing);
    }

    public getInMemoryDataProcessingThresholdConfig(): number {
        return this.vscodeWrapper
            .getConfiguration(Constants.extensionName)
            .get(Constants.configInMemoryDataProcessingThreshold);
    }

    public getFontSizeConfig(): number {
        return (
            (this.vscodeWrapper
                .getConfiguration(Constants.extensionName)
                .get(Constants.extConfigResultKeys.ResultsFontSize) as number) ??
            (this.vscodeWrapper.getConfiguration("editor").get("fontSize") as number)
        );
    }

    public getFontFamilyConfig(): string {
        return this.vscodeWrapper
            .getConfiguration(Constants.extensionName)
            .get(Constants.extConfigResultKeys.ResultsFontFamily) as string;
    }

    public setQueryResultState(uri: string, state: qr.QueryResultWebviewState) {
        console.log(`[QueryResultWebviewController] setQueryResultState called for URI: ${uri}`);
        console.log(
            `[QueryResultWebviewController] setQueryResultState state:`,
            JSON.stringify(state, null, 2),
        );
        this._queryResultStateMap.set(uri, state);
    }

    public deleteQueryResultState(uri: string): void {
        this._queryResultStateMap.delete(uri);
    }

    public updatePanelState(uri: string): void {
        console.log(`[QueryResultWebviewController] updatePanelState called for URI: ${uri}`);
        const state = this.getQueryResultState(uri);
        console.log(
            `[QueryResultWebviewController] updatePanelState state:`,
            JSON.stringify(state, null, 2),
        );
        if (!this._queryResultWebviewPanelControllerMap.has(uri)) {
            // Panel is missing, recreate it
            void this.createPanelController(uri).then(() => {
                // After creation, update the panel state with the latest results
                const panel = this._queryResultWebviewPanelControllerMap.get(uri);
                if (panel) {
                    console.log(
                        `[QueryResultWebviewController] Panel created for URI: ${uri}, updating state.`,
                    );
                    panel.updateState(this.getQueryResultState(uri));
                    panel.revealToForeground();
                }
            });
            return;
        }
        const panel = this._queryResultWebviewPanelControllerMap.get(uri);
        if (panel) {
            console.log(
                `[QueryResultWebviewController] Panel exists for URI: ${uri}, updating state.`,
            );
            panel.updateState(this.getQueryResultState(uri));
            panel.revealToForeground();
        }
    }

    public getQueryResultState(uri: string): qr.QueryResultWebviewState {
        var res = this._queryResultStateMap.get(uri);
        if (!res) {
            // This should never happen
            const error = new Error(`No query result state found for uri ${uri}`);
            sendErrorEvent(
                TelemetryViews.QueryResult,
                TelemetryActions.GetQueryResultState,
                error,
                false, // includeErrorMessage
            );
            throw error;
        }
        console.log(
            `[QueryResultWebviewController] getQueryResultState for URI: ${uri}`,
            JSON.stringify(res, null, 2),
        );
        return res;
    }
}
