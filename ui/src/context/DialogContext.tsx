import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { IssueWorkMode } from "@paperclipai/shared";

interface NewIssueDefaults {
  status?: string;
  workMode?: IssueWorkMode;
  priority?: string;
  projectId?: string;
  projectWorkspaceId?: string;
  goalId?: string;
  parentId?: string;
  parentIdentifier?: string;
  parentTitle?: string;
  executionWorkspaceId?: string;
  executionWorkspaceMode?: string;
  assigneeAgentId?: string;
  assigneeUserId?: string;
  title?: string;
  description?: string;
  /** Open the created task after submission; disabled unless the caller opts in. */
  navigateOnCreate?: boolean;
}

/** The created issue, as reported back to whoever opened the New Task dialog. */
export interface NewIssueCreatedSummary {
  id: string;
  identifier: string | null;
  title: string;
  projectId: string | null;
  assigneeAgentId: string | null;
}

/**
 * Optional callbacks for one opening of the New Task dialog. `onCreated` runs
 * once when the dialog creates an issue; `onClosed` runs once when that opening
 * ends (after a create, on cancel, or when another opening replaces it).
 */
export interface NewIssueHandlers {
  onCreated?: (issue: NewIssueCreatedSummary) => void;
  onClosed?: () => void;
}

interface NewGoalDefaults {
  parentId?: string;
}

interface OnboardingOptions {
  initialStep?: 1 | 2 | 3 | 4;
  companyId?: string;
}

interface DialogContextValue {
  newIssueOpen: boolean;
  newIssueDefaults: NewIssueDefaults;
  openNewIssue: (defaults?: NewIssueDefaults, handlers?: NewIssueHandlers) => void;
  closeNewIssue: () => void;
  /** Called by the New Task dialog after it created an issue. */
  notifyNewIssueCreated: (issue: NewIssueCreatedSummary) => void;
  newProjectOpen: boolean;
  openNewProject: () => void;
  closeNewProject: () => void;
  newGoalOpen: boolean;
  newGoalDefaults: NewGoalDefaults;
  openNewGoal: (defaults?: NewGoalDefaults) => void;
  closeNewGoal: () => void;
  newAgentOpen: boolean;
  openNewAgent: () => void;
  closeNewAgent: () => void;
  onboardingOpen: boolean;
  onboardingOptions: OnboardingOptions;
  openOnboarding: (options?: OnboardingOptions) => void;
  closeOnboarding: () => void;
  // Whether the user has dismissed the route-driven onboarding wizard (the one
  // that auto-opens on /onboarding). Shared so the route launcher can hand off
  // fully to the wizard instead of remaining interactive behind it.
  onboardingRouteDismissed: boolean;
  setOnboardingRouteDismissed: (dismissed: boolean) => void;
}

type DialogStateValue = Pick<
  DialogContextValue,
  | "newIssueOpen"
  | "newIssueDefaults"
  | "newProjectOpen"
  | "newGoalOpen"
  | "newGoalDefaults"
  | "newAgentOpen"
  | "onboardingOpen"
  | "onboardingOptions"
  | "onboardingRouteDismissed"
>;

type DialogActionsValue = Omit<DialogContextValue, keyof DialogStateValue>;

const DialogStateContext = createContext<DialogStateValue | null>(null);
const DialogActionsContext = createContext<DialogActionsValue | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [newIssueDefaults, setNewIssueDefaults] = useState<NewIssueDefaults>({});
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newGoalOpen, setNewGoalOpen] = useState(false);
  const [newGoalDefaults, setNewGoalDefaults] = useState<NewGoalDefaults>({});
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingOptions, setOnboardingOptions] = useState<OnboardingOptions>({});
  const [onboardingRouteDismissed, setOnboardingRouteDismissed] = useState(false);

  const newIssueHandlersRef = useRef<NewIssueHandlers | null>(null);

  const endNewIssueHandlers = useCallback(() => {
    const handlers = newIssueHandlersRef.current;
    newIssueHandlersRef.current = null;
    try {
      handlers?.onClosed?.();
    } catch {
      // A caller's callback must never break the host dialog.
    }
  }, []);

  const openNewIssue = useCallback((defaults: NewIssueDefaults = {}, handlers?: NewIssueHandlers) => {
    endNewIssueHandlers();
    newIssueHandlersRef.current = handlers ?? null;
    setNewIssueDefaults(defaults);
    setNewIssueOpen(true);
  }, [endNewIssueHandlers]);

  const closeNewIssue = useCallback(() => {
    endNewIssueHandlers();
    setNewIssueOpen(false);
    setNewIssueDefaults({});
  }, [endNewIssueHandlers]);

  const notifyNewIssueCreated = useCallback((issue: NewIssueCreatedSummary) => {
    const onCreated = newIssueHandlersRef.current?.onCreated;
    if (newIssueHandlersRef.current) newIssueHandlersRef.current.onCreated = undefined;
    try {
      onCreated?.(issue);
    } catch {
      // A caller's callback must never break the host dialog.
    }
  }, []);

  const openNewProject = useCallback(() => {
    setNewProjectOpen(true);
  }, []);

  const closeNewProject = useCallback(() => {
    setNewProjectOpen(false);
  }, []);

  const openNewGoal = useCallback((defaults: NewGoalDefaults = {}) => {
    setNewGoalDefaults(defaults);
    setNewGoalOpen(true);
  }, []);

  const closeNewGoal = useCallback(() => {
    setNewGoalOpen(false);
    setNewGoalDefaults({});
  }, []);

  const openNewAgent = useCallback(() => {
    setNewAgentOpen(true);
  }, []);

  const closeNewAgent = useCallback(() => {
    setNewAgentOpen(false);
  }, []);

  const openOnboarding = useCallback((options: OnboardingOptions = {}) => {
    setOnboardingOptions(options);
    setOnboardingOpen(true);
  }, []);

  const closeOnboarding = useCallback(() => {
    setOnboardingOpen(false);
    setOnboardingOptions({});
  }, []);

  const stateValue = useMemo<DialogStateValue>(
    () => ({
      newIssueOpen,
      newIssueDefaults,
      newProjectOpen,
      newGoalOpen,
      newGoalDefaults,
      newAgentOpen,
      onboardingOpen,
      onboardingOptions,
      onboardingRouteDismissed,
    }),
    [
      newIssueOpen,
      newIssueDefaults,
      newProjectOpen,
      newGoalOpen,
      newGoalDefaults,
      newAgentOpen,
      onboardingOpen,
      onboardingOptions,
      onboardingRouteDismissed,
    ],
  );

  const actionsValue = useMemo<DialogActionsValue>(
    () => ({
      openNewIssue,
      closeNewIssue,
      notifyNewIssueCreated,
      openNewProject,
      closeNewProject,
      openNewGoal,
      closeNewGoal,
      openNewAgent,
      closeNewAgent,
      openOnboarding,
      closeOnboarding,
      setOnboardingRouteDismissed,
    }),
    [
      openNewIssue,
      closeNewIssue,
      notifyNewIssueCreated,
      openNewProject,
      closeNewProject,
      openNewGoal,
      closeNewGoal,
      openNewAgent,
      closeNewAgent,
      openOnboarding,
      closeOnboarding,
      setOnboardingRouteDismissed,
    ],
  );

  return (
    <DialogActionsContext.Provider value={actionsValue}>
      <DialogStateContext.Provider value={stateValue}>
        {children}
      </DialogStateContext.Provider>
    </DialogActionsContext.Provider>
  );
}

export function useDialogActions() {
  const ctx = useContext(DialogActionsContext);
  if (!ctx) {
    throw new Error("useDialogActions must be used within DialogProvider");
  }
  return ctx;
}

export function useDialogState() {
  const ctx = useContext(DialogStateContext);
  if (!ctx) {
    throw new Error("useDialogState must be used within DialogProvider");
  }
  return ctx;
}

export function useDialog() {
  return {
    ...useDialogState(),
    ...useDialogActions(),
  };
}
