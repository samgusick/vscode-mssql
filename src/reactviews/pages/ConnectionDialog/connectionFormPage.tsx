/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useContext, useState } from "react";
import { Dropdown, Option, Button } from "@fluentui/react-components";
import { ConnectionDialogContext } from "./connectionDialogStateProvider";
import { FormField, useFormStyles } from "../../common/forms/form.component";
import {
    ConnectionDialogContextProps,
    ConnectionDialogFormItemSpec,
    ConnectionDialogWebviewState,
    IConnectionDialogProfile,
} from "../../../sharedInterfaces/connectionDialog";
import { ConnectButton } from "./components/connectButton.component";
import { locConstants } from "../../common/locConstants";
import { AdvancedOptionsDrawer } from "./components/advancedOptionsDrawer.component";
import { SearchableDropdown } from "../../common/searchableDropdown.component";

export const ConnectionFormPage = () => {
    const context = useContext(ConnectionDialogContext);
    const [isAdvancedDrawerOpen, setIsAdvancedDrawerOpen] = useState(false);
    const [scope, setScope] = useState<"user" | "workspace">("user");
    const formStyles = useFormStyles();

    if (context === undefined) {
        return undefined;
    }

    return (
        <div>
            {/* Scope Dropdown */}
            <div style={{ marginBottom: 16 }}>
                <SearchableDropdown
                    options={[
                        { value: "user", text: "User Settings" },
                        { value: "workspace", text: "Workspace Settings" },
                    ]}
                    selectedOption={{
                        value: scope,
                        text: scope === "user" ? "User Settings" : "Workspace Settings",
                    }}
                    onSelect={(option) => setScope(option.value as "user" | "workspace")}
                />
            </div>
            {context.state.connectionComponents.mainOptions.map((inputName, idx) => {
                const component =
                    context.state.formComponents[inputName as keyof IConnectionDialogProfile];
                if (component?.hidden !== false) {
                    return undefined;
                }

                return (
                    <FormField<
                        IConnectionDialogProfile,
                        ConnectionDialogWebviewState,
                        ConnectionDialogFormItemSpec,
                        ConnectionDialogContextProps
                    >
                        key={idx}
                        context={context}
                        component={component}
                        idx={idx}
                        props={{ orientation: "horizontal" }}
                    />
                );
            })}
            <AdvancedOptionsDrawer
                isAdvancedDrawerOpen={isAdvancedDrawerOpen}
                setIsAdvancedDrawerOpen={setIsAdvancedDrawerOpen}
            />
            <div className={formStyles.formNavTray}>
                <Button
                    onClick={(_event) => {
                        setIsAdvancedDrawerOpen(!isAdvancedDrawerOpen);
                    }}
                    className={formStyles.formNavTrayButton}>
                    {locConstants.connectionDialog.advancedSettings}
                </Button>
                <div className={formStyles.formNavTrayRight}>
                    {/* Pass scope to ConnectButton via context or props as needed */}
                    <ConnectButton className={formStyles.formNavTrayButton} scope={scope} />
                </div>
            </div>
        </div>
    );
};
