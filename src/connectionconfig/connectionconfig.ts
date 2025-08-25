/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Constants from "../constants/constants";
import * as LocalizedConstants from "../constants/locConstants";
import * as Utils from "../models/utils";
import { IConnectionGroup, IConnectionProfile } from "../models/interfaces";
import { IConnectionConfig } from "./iconnectionconfig";
import VscodeWrapper, { ConfigurationTarget } from "../controllers/vscodeWrapper";
import { ConnectionProfile } from "../models/connectionProfile";
import { getConnectionDisplayName } from "../models/connectionInfo";
import { Deferred } from "../protocol";
import { Logger } from "../models/logger";

export type ConfigTarget = ConfigurationTarget.Global | ConfigurationTarget.Workspace;

/**
 * Implements connection profile file storage.
 */
export class ConnectionConfig implements IConnectionConfig {
    protected _logger: Logger;
    public initialized: Deferred<void> = new Deferred<void>();

    /** The name and ID of the root connection group. */
    static readonly RootGroupId: string = Constants.ROOT_GROUP_ID;
    static readonly RootGroupName: string = Constants.ROOT_GROUP_NAME;
    private _hasDisplayedMissingIdError: boolean = false;

    /**
     * Constructor
     */
    public constructor(private _vscodeWrapper?: VscodeWrapper) {
        if (!this._vscodeWrapper) {
            this._vscodeWrapper = new VscodeWrapper();
        }

        this._logger = Logger.create(this._vscodeWrapper.outputChannel, "ConnectionConfig");
        void this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.assignConnectionGroupMissingIds();
        await this.assignConnectionMissingIds();

        this.initialized.resolve();
    }

    //#region Connection Profiles

    /**
     * Get a list of all connections in the connection config. Connections returned
     * are sorted first by whether they were found in the user/workspace settings,
     * and next alphabetically by profile/server name.
     */
    public async getConnections(alsoGetFromWorkspace: boolean): Promise<IConnectionProfile[]> {
        await this.initialized;

        let profiles: IConnectionProfile[] = [];

        // Read from user settings
        let userProfiles = this.getConnectionsFromSettings();

        userProfiles.sort(this.compareConnectionProfile);
        profiles = profiles.concat(userProfiles);

        if (alsoGetFromWorkspace) {
            // Read from workspace settings
            let workspaceProfiles = this.getConnectionsFromSettings(ConfigurationTarget.Workspace);

            const missingIdConns: IConnectionProfile[] = [];

            workspaceProfiles = workspaceProfiles.filter((profile) => {
                if (!profile.id) {
                    if (!this._hasDisplayedMissingIdError) {
                        missingIdConns.push(profile);
                    }

                    return false;
                }
                return true;
            });

            if (missingIdConns.length > 0) {
                // We don't currently auto-update connections in workspace/workspace folder config,
                // so alert the user if any of those are missing their ID property that they need manual updating.

                this._hasDisplayedMissingIdError = true;
                this._vscodeWrapper.showErrorMessage(
                    LocalizedConstants.Connection.missingConnectionIdsError(
                        missingIdConns.map((c) => getConnectionDisplayName(c)),
                    ),
                );
            }

            workspaceProfiles.sort(this.compareConnectionProfile);
            profiles = profiles.concat(workspaceProfiles);
        }

        if (profiles.length > 0) {
            profiles = profiles.filter((conn) => {
                // filter any connection missing a connection string and server name or the sample that's shown by default
                if (
                    !(
                        conn.connectionString ||
                        (!!conn.server && conn.server !== LocalizedConstants.SampleServerName)
                    )
                ) {
                    this._vscodeWrapper.showErrorMessage(
                        LocalizedConstants.Connection.missingConnectionInformation(conn.id),
                    );

                    return false;
                }
                return true;
            });
        }

        // filter out any connection with a group that isn't defined
        const groupIds = new Set<string>((await this.getGroups()).map((g) => g.id));
        profiles = profiles.filter((p) => {
            if (!groupIds.has(p.groupId)) {
                this._logger.warn(
                    `Connection '${getConnectionDisplayName(p)}' with ID '${p.id}' has a group ID that does not exist (${p.groupId}) so it is being ignored.  Correct its group ID to keep using this connection.`,
                );
                return false;
            } else {
                return true;
            }
        });

        return profiles;
    }

    public async getConnectionById(id: string): Promise<IConnectionProfile | undefined> {
        await this.initialized;

        const profiles = await this.getConnections(true /* getFromWorkspace */);
        return profiles.find((profile) => profile.id === id);
    }

    /**
     * Add a connection profile to user or workspace settings.
     * @param profile The connection profile to add.
     * @param scope 'user' for global, 'workspace' for workspace settings.
     */
    public async addConnection(
        profile: IConnectionProfile,
        scope: "user" | "workspace" = "user",
    ): Promise<void> {
        this.populateMissingConnectionIds(profile);
        const configTarget =
            scope === "user" ? ConfigurationTarget.Global : ConfigurationTarget.Workspace;
        // Read current profiles from the correct scope
        let profiles = this.getConnectionsFromSettings(configTarget);
        // Remove any existing profile that matches
        profiles = profiles.filter((value) => !Utils.isSameProfile(value, profile));
        // Append the new profile
        profiles.push(profile);
        // Write the updated array back to the correct scope
        await this.writeConnectionsToSettings(profiles, configTarget);
        return;
    }

    /**
     * Remove an existing connection from the connection config if it exists.
     * @returns true if the connection was removed, false if the connection wasn't found.
     */
    public async removeConnection(profile: IConnectionProfile): Promise<boolean> {
        let profiles = await this.getConnections(false /* getWorkspaceConnections */);

        const found = this.removeConnectionHelper(profile, profiles);
        if (found) {
            await this.writeConnectionsToSettings(profiles);
        }
        return found;
    }

    public async updateConnection(updatedProfile: IConnectionProfile): Promise<void> {
        const profiles = await this.getConnections(false /* getWorkspaceConnections */);
        const index = profiles.findIndex((p) => p.id === updatedProfile.id);
        if (index === -1) {
            throw new Error(`Connection with ID ${updatedProfile.id} not found`);
        }
        profiles[index] = updatedProfile;
        await this.writeConnectionsToSettings(profiles);
    }

    //#endregion

    //#region Connection Groups

    /**
     * Returns the hard-coded ROOT connection group.
     */
    public getRootGroup(): IConnectionGroup {
        return {
            id: ConnectionConfig.RootGroupId,
            name: ConnectionConfig.RootGroupName,
            parentId: undefined,
        };
    }

    public async getGroups(
        location: ConfigTarget = ConfigurationTarget.Global,
    ): Promise<IConnectionGroup[]> {
        await this.initialized;
        // Always include the hard-coded ROOT group at the top
        const groups = this.getGroupsFromSettings(location).filter(
            (g) => g.id !== ConnectionConfig.RootGroupId,
        );
        return [this.getRootGroup(), ...groups];
    }

    /**
     * Retrieves a connection group by its ID.
     * @param id The ID of the connection group to retrieve.
     * @returns The connection group with the specified ID, or `undefined` if not found.
     */
    public getGroupById(id: string): IConnectionGroup | undefined {
        if (id === ConnectionConfig.RootGroupId) {
            return this.getRootGroup();
        }
        const connGroups = this.getGroupsFromSettings(ConfigurationTarget.Global);
        return connGroups.find((g) => g.id === id);
    }

    public addGroup(group: IConnectionGroup, scope: "user" | "workspace" = "user"): Promise<void> {
        // Prevent adding the ROOT group to settings
        if (group.id === ConnectionConfig.RootGroupId) {
            return Promise.resolve();
        }
        if (!group.id) {
            group.id = Utils.generateGuid();
        }
        if (!group.parentId) {
            group.parentId = ConnectionConfig.RootGroupId;
        }
        const configTarget =
            scope === "user" ? ConfigurationTarget.Global : ConfigurationTarget.Workspace;
        const groups = this.getGroupsFromSettings(configTarget).filter(
            (g) => g.id !== ConnectionConfig.RootGroupId,
        );
        groups.push(group);
        return this.writeConnectionGroupsToSettings(groups, configTarget);
    }

    /**
     * Remove a connection group and handle its contents.
     * @param id The ID of the group to remove
     * @param deleteContents If true, delete all connections and subgroups in this group.
     *                      If false, move immediate child connections and groups to root, preserving their hierarchies.
     * @returns true if the group was removed, false if the group wasn't found.
     */
    public async removeGroup(
        id: string,
        contentAction: "delete" | "move" = "delete",
    ): Promise<boolean> {
        const connections = this.getConnectionsFromSettings();
        const groups = this.getGroupsFromSettings();
        const rootGroup = this.getRootGroup();

        if (!rootGroup) {
            throw new Error("Root group not found when removing group");
        }

        // Find all subgroup IDs recursively for the delete case
        const getAllSubgroupIds = (groupId: string): Set<string> => {
            const subgroupIds = new Set<string>();
            subgroupIds.add(groupId);
            for (const group of groups) {
                if (group.parentId === groupId) {
                    const childSubgroups = getAllSubgroupIds(group.id);
                    childSubgroups.forEach((id) => subgroupIds.add(id));
                }
            }
            return subgroupIds;
        };

        let connectionModified = false;
        let remainingConnections: IConnectionProfile[];
        let remainingGroups: IConnectionGroup[];

        if (id === ConnectionConfig.RootGroupId) {
            // Never remove the ROOT group
            this._logger.error("Attempted to remove ROOT group, which is not allowed.");
            return false;
        }
        if (contentAction === "delete") {
            // Get all nested subgroups to remove
            const groupsToRemove = getAllSubgroupIds(id);
            // Remove all connections in the groups being removed
            remainingConnections = connections.filter((conn) => {
                if (groupsToRemove.has(conn.groupId)) {
                    this._logger.verbose(
                        `Removing connection '${conn.id}' because its group '${conn.groupId}' was removed`,
                    );
                    connectionModified = true;
                    return false;
                }
                return true;
            });
            // Remove all groups that were marked for removal, but never remove ROOT
            remainingGroups = groups.filter(
                (g) => !groupsToRemove.has(g.id) && g.id !== ConnectionConfig.RootGroupId,
            );
        } else {
            // Move immediate child connections to root
            remainingConnections = connections.map((conn) => {
                if (conn.groupId === id) {
                    this._logger.verbose(
                        `Moving connection '${conn.id}' to root group because its immediate parent group '${id}' was removed`,
                    );
                    connectionModified = true;
                    return { ...conn, groupId: rootGroup.id };
                }
                return conn;
            });
            // First remove the target group, but never remove ROOT
            remainingGroups = groups.filter(
                (g) => g.id !== id && g.id !== ConnectionConfig.RootGroupId,
            );
            // Then reparent immediate children to root
            remainingGroups = remainingGroups.map((g) => {
                if (g.parentId === id) {
                    this._logger.verbose(
                        `Moving group '${g.id}' to root group because its immediate parent group '${id}' was removed`,
                    );
                    return { ...g, parentId: rootGroup.id };
                }
                return g;
            });
        }

        if (remainingGroups.length === groups.length) {
            this._logger.error(`Connection group with ID '${id}' not found when removing.`);
            return false;
        }

        if (connectionModified) {
            await this.writeConnectionsToSettings(remainingConnections);
        }

        await this.writeConnectionGroupsToSettings(remainingGroups);
        return true;
    }

    public async updateGroup(updatedGroup: IConnectionGroup): Promise<void> {
        // Prevent updating the ROOT group in settings
        if (updatedGroup.id === ConnectionConfig.RootGroupId) {
            return;
        }
        const groups = this.getGroupsFromSettings().filter(
            (g) => g.id !== ConnectionConfig.RootGroupId,
        );
        const index = groups.findIndex((g) => g.id === updatedGroup.id);
        if (index === -1) {
            throw Error(`Connection group with ID ${updatedGroup.id} not found when updating`);
        } else {
            groups[index] = updatedGroup;
        }
        return await this.writeConnectionGroupsToSettings(groups);
    }

    //#endregion

    //#region Shared/Helpers

    private removeConnectionHelper(
        toRemove: IConnectionProfile,
        profiles: IConnectionProfile[],
    ): boolean {
        let found = false;
        for (let i = profiles.length - 1; i >= 0; i--) {
            if (Utils.isSameProfile(profiles[i], toRemove)) {
                profiles.splice(i, 1);
                found = true;
            }
        }
        return found;
    }

    /** Compare function for sorting by profile name if available, otherwise fall back to server name or connection string */
    private compareConnectionProfile(connA: IConnectionProfile, connB: IConnectionProfile): number {
        const nameA = connA.profileName
            ? connA.profileName
            : connA.server
              ? connA.server
              : connA.connectionString;
        const nameB = connB.profileName
            ? connB.profileName
            : connB.server
              ? connB.server
              : connB.connectionString;

        return nameA.localeCompare(nameB);
    }

    /**
     * Populate missing connection ID and group ID for a connection profile.
     * @returns true if the profile was modified, false otherwise.
     */
    public populateMissingConnectionIds(profile: IConnectionProfile): boolean {
        let modified = false;
        // ensure each profile is in a group
        if (profile.groupId === undefined) {
            profile.groupId = ConnectionConfig.RootGroupId;
            modified = true;
        }
        // ensure each profile has an ID
        if (profile.id === undefined) {
            ConnectionProfile.addIdIfMissing(profile);
            modified = true;
        }
        return modified;
    }

    //#endregion

    //#region Initialization

    private async assignConnectionGroupMissingIds(): Promise<void> {
        let madeChanges = false;
        let groups: IConnectionGroup[] = this.getGroupsFromSettings().filter(
            (g) => g.id !== ConnectionConfig.RootGroupId,
        );
        // Find legacy ROOT group IDs in settings (any group with name 'ROOT' but not the hard-coded ID)
        const legacyRootGroups = this.getGroupsFromSettings().filter(
            (g) =>
                g.name === ConnectionConfig.RootGroupName && g.id !== ConnectionConfig.RootGroupId,
        );
        const legacyRootIds = legacyRootGroups.map((g) => g.id);
        // Gather all valid group IDs (including hard-coded ROOT)
        const allGroups = this.getGroupsFromSettings().filter(
            (g) => g.id !== ConnectionConfig.RootGroupId,
        );
        const validGroupIds = new Set([
            ConnectionConfig.RootGroupId,
            ...allGroups.map((g) => g.id),
        ]);
        for (const group of groups) {
            // Migrate legacy groups whose parentId is a legacy ROOT group ID
            if (legacyRootIds.includes(group.parentId)) {
                group.parentId = ConnectionConfig.RootGroupId;
                madeChanges = true;
                this._logger.logDebug(
                    `Migrated group '${group.name}' from legacy ROOT parent to new hard-coded ROOT group.`,
                );
            }
            // Re-parent orphaned groups to ROOT
            if (group.parentId && !validGroupIds.has(group.parentId)) {
                group.parentId = ConnectionConfig.RootGroupId;
                madeChanges = true;
                this._logger.logDebug(`Re-parented orphaned group '${group.name}' to ROOT.`);
            }
            // ensure each group has an ID
            if (!group.id) {
                group.id = Utils.generateGuid();
                madeChanges = true;
                this._logger.logDebug(`Adding missing ID to connection group '${group.name}'`);
            }
            // ensure each group is in a group
            if (!group.parentId) {
                group.parentId = ConnectionConfig.RootGroupId;
                madeChanges = true;
                this._logger.logDebug(`Adding missing parentId to connection '${group.name}'`);
            }
        }
        // Save the changes to settings
        if (madeChanges) {
            this._logger.logDebug(
                `Updates made to connection groups.  Writing all ${groups.length} group(s) to settings.`,
            );
            await this.writeConnectionGroupsToSettings(groups);
        }
    }

    private async assignConnectionMissingIds(): Promise<void> {
        let madeChanges = false;

        // Clean up connection profiles
        const profiles: IConnectionProfile[] = this.getConnectionsFromSettings();

        // Find legacy ROOT group IDs in settings (any group with name 'ROOT' but not the hard-coded ID)
        const legacyRootGroups = this.getGroupsFromSettings().filter(
            (g) =>
                g.name === ConnectionConfig.RootGroupName && g.id !== ConnectionConfig.RootGroupId,
        );
        const legacyRootIds = legacyRootGroups.map((g) => g.id);
        // Gather all valid group IDs (including hard-coded ROOT)
        const validGroupIds = new Set([
            ConnectionConfig.RootGroupId,
            ...profiles.map((p) => p.groupId),
        ]);

        for (const profile of profiles) {
            // Migrate legacy connections with old ROOT group IDs
            if (legacyRootIds.includes(profile.groupId)) {
                profile.groupId = ConnectionConfig.RootGroupId;
                madeChanges = true;
                this._logger.logDebug(
                    `Migrated connection '${getConnectionDisplayName(profile)}' from legacy ROOT group to new hard-coded ROOT group.`,
                );
            }
            // Re-parent orphaned connections to ROOT
            if (profile.groupId && !validGroupIds.has(profile.groupId)) {
                profile.groupId = ConnectionConfig.RootGroupId;
                madeChanges = true;
                this._logger.logDebug(
                    `Re-parented orphaned connection '${getConnectionDisplayName(profile)}' to ROOT.`,
                );
            }
            if (this.populateMissingConnectionIds(profile)) {
                madeChanges = true;
                this._logger.logDebug(
                    `Adding missing group ID or connection ID to connection '${getConnectionDisplayName(profile)}'`,
                );
            }
        }

        // Save the changes to settings
        if (madeChanges) {
            this._logger.logDebug(
                `Updates made to connection profiles.  Writing all ${profiles.length} profile(s) to settings.`,
            );
            await this.writeConnectionsToSettings(profiles);
        }
    }

    //#endregion

    //#region Config Read/Write

    /**
     * Get all profiles from the settings.
     * This is public for testing only.
     * @param configLocation When `true` profiles come from user settings, otherwise from workspace settings.  Default is `true`.
     * @returns the set of connection profiles found in the settings.
     */
    public getConnectionsFromSettings(
        configLocation: ConfigTarget = ConfigurationTarget.Global,
    ): IConnectionProfile[] {
        return this.getArrayFromSettings<IConnectionProfile>(
            Constants.connectionsArrayName,
            configLocation,
        );
    }

    public getGroupsFromSettings(
        configLocation: ConfigTarget = ConfigurationTarget.Global,
    ): IConnectionGroup[] {
        return this.getArrayFromSettings<IConnectionGroup>(
            Constants.connectionGroupsArrayName,
            configLocation,
        );
    }

    /**
     * Replace existing profiles in the user settings with a new set of profiles.
     * @param profiles the set of profiles to insert into the settings file.
     */
    private async writeConnectionsToSettings(
        profiles: IConnectionProfile[],
        configTarget: ConfigurationTarget = ConfigurationTarget.Global,
    ): Promise<void> {
        // Save the file
        await this._vscodeWrapper.setConfiguration(
            Constants.extensionName,
            Constants.connectionsArrayName,
            profiles,
            configTarget,
        );
    }

    private async writeConnectionGroupsToSettings(
        connGroups: IConnectionGroup[],
        configTarget: ConfigurationTarget = ConfigurationTarget.Global,
    ): Promise<void> {
        await this._vscodeWrapper.setConfiguration(
            Constants.extensionName,
            Constants.connectionGroupsArrayName,
            connGroups,
            configTarget,
        );
    }

    private getArrayFromSettings<T>(
        configSection: string,
        location:
            | ConfigurationTarget.Global
            | ConfigurationTarget.Workspace = ConfigurationTarget.Global,
    ): T[] {
        let configuration = this._vscodeWrapper.getConfiguration(
            Constants.extensionName,
            this._vscodeWrapper.activeTextEditorUri,
        );

        let configValue = configuration.inspect<T[]>(configSection);
        if (location === ConfigurationTarget.Global) {
            // only return the global values if that's what's requested
            return configValue.globalValue || [];
        } else {
            // otherwise, return the combination of the workspace and workspace folder values
            return (configValue.workspaceValue || []).concat(
                configValue.workspaceFolderValue || [],
            );
        }
    }

    //#endregion
}
