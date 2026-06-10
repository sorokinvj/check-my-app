import { redirect } from "next/navigation";

// No landing page in MVP — go straight to the submit screen.
export default function Home() {
  redirect("/check");
}
