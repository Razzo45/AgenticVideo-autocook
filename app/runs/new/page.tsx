import { redirect } from "next/navigation";

/** Autocook entry — product path is auto (or audio). */
export default function NewRunRedirect() {
  redirect("/runs/new/auto");
}
