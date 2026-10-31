import { useTranslation } from "react-i18next";

/** Daemon errors arrive as codes ("assistant.daily_cap", "admission.memory"); keys use underscores. */
export function useAssistantError(): (err: unknown) => string {
  const { t } = useTranslation("assistant");
  return (err) => {
    const code = (err instanceof Error ? err.message : String(err)).replace(/^.*Error: /, "").trim();
    return t(`errors.${code.replace(/\./g, "_")}`, { defaultValue: t("errors.other", { message: code }) });
  };
}
