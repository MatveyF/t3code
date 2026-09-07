import {
  BookOpenIcon,
  BriefcaseIcon,
  BugIcon,
  CodeIcon,
  FlaskConicalIcon,
  FolderIcon,
  HeartIcon,
  HomeIcon,
  InboxIcon,
  type LucideIcon,
  RocketIcon,
  SparklesIcon,
  StarIcon,
  TargetIcon,
  UsersIcon,
  ZapIcon,
} from "lucide-react";
import { type SidebarFolderIconName } from "../uiStateStore";

/** Glyph choices for sidebar folders (fork feature). Names are persisted; components are not. */
export const SIDEBAR_FOLDER_ICONS: Record<
  SidebarFolderIconName,
  { readonly label: string; readonly Icon: LucideIcon }
> = {
  folder: { label: "Folder", Icon: FolderIcon },
  star: { label: "Star", Icon: StarIcon },
  briefcase: { label: "Briefcase", Icon: BriefcaseIcon },
  flask: { label: "Flask", Icon: FlaskConicalIcon },
  bug: { label: "Bug", Icon: BugIcon },
  rocket: { label: "Rocket", Icon: RocketIcon },
  heart: { label: "Heart", Icon: HeartIcon },
  zap: { label: "Zap", Icon: ZapIcon },
  book: { label: "Book", Icon: BookOpenIcon },
  home: { label: "Home", Icon: HomeIcon },
  users: { label: "People", Icon: UsersIcon },
  code: { label: "Code", Icon: CodeIcon },
  sparkles: { label: "Sparkles", Icon: SparklesIcon },
  target: { label: "Target", Icon: TargetIcon },
  inbox: { label: "Inbox", Icon: InboxIcon },
};

export function resolveSidebarFolderIcon(name: SidebarFolderIconName | undefined): LucideIcon {
  return SIDEBAR_FOLDER_ICONS[name ?? "folder"].Icon;
}
