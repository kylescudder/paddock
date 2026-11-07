// Optional first/last names are Better Auth additional fields; the verified
// email is shown read-only because it is the account's identity and access key.
const name = (field: "givenName" | "familyName", label: string) => ({
  name: field,
  type: "string" as const,
  label,
  defaultValue: "",
  validateDebounceMs: 0,
  validate: (value: unknown) => {
    if (typeof value === "string" && value.length > 100)
      throw new Error("Use up to 100 characters.");
  },
});

export const profileFields = [
  name("givenName", "First name"),
  name("familyName", "Last name"),
  {
    name: "email",
    type: "string" as const,
    label: "Verified email",
    readOnly: true,
    copyable: true,
  },
];
