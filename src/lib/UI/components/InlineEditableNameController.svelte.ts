export class InlineEditableNameController {
    connected = $state(false);
    disabled = $state(true);
    editing = $state(false);
    private startEditingHandler: ((event?: Event) => void) | undefined;

    connect(startEditing: (event?: Event) => void) {
        this.startEditingHandler = startEditing;
        this.connected = true;
    }

    updateStatus(disabled: boolean, editing: boolean) {
        this.disabled = disabled;
        this.editing = editing;
    }

    disconnect(startEditing: (event?: Event) => void) {
        if (this.startEditingHandler !== startEditing) return;
        this.startEditingHandler = undefined;
        this.connected = false;
        this.disabled = true;
        this.editing = false;
    }

    startEditing(event?: Event) {
        this.startEditingHandler?.(event);
    }
}
