/**
 * Site chrome — the application shell every page renders inside (P-16).
 *
 * Purpose: the legacy layouts/application.rhtml structure harvested as
 * one presentational component: `#doc` wrapping the header
 * (_application_hd.rhtml — logo, project name, header actions, user
 * menu from shared/_profile_utilities.rhtml, and the project tab bar
 * from _tabs.rhtml), the body (`#bd` > `#main.page-content` >
 * `.main_inner` with the `#flash` slot from _flash.rhtml ahead of the
 * page), and the fixed footbar (_footbar.rhtml). Purely presentational:
 * everything it shows arrives as a `SiteContext` from the root loader.
 * Outside a project the header carries the legacy top-level pills
 * (shared/_top_level_header_pills.rhtml: Programs, Projects, Admin)
 * with the current one marked from the URL. Header actions that had
 * no route in the port (search, murmur drop-down badge) are not
 * carried; the sidebar and its control are left to the pages that own
 * one.
 *
 * Public interface: `SiteChrome`.
 *
 * Owner context: application shell (presentation).
 */
import { Link, useLocation } from "react-router";
import type { SiteContext, SiteTab } from "~/shared/wire-types";
import "../styles/site.css";

/** Legacy `tab_class` plus the tab's `image_name` icon class. */
function tabClassName(tab: SiteTab): string {
  const state = tab.current ? "current-menu-item" : "menu-item";
  return `${state} ${tab.kind}-tab`;
}

/** The project tab bar (legacy layouts/_tabs.rhtml). */
function ProjectTabs({ tabs }: { tabs: SiteTab[] }) {
  return (
    <div id="hd-nav">
      <div className="tab-nav">
        <ul className="sortable-tabs">
          {tabs.map((tab) => (
            <li
              key={tab.htmlId}
              id={tab.htmlId}
              className={tabClassName(tab)}
              data-tab-name={tab.name}
            >
              <span className="first-link">
                <Link to={tab.href} id={`${tab.htmlId}_link`} title={tab.name} role="tab-name">
                  {tab.name}
                </Link>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The user menu (legacy shared/_profile_utilities.rhtml). */
function ProfileUtilities({ user }: { user: SiteContext["user"] }) {
  return (
    <div className="profile_utilities">
      <ul className={user ? undefined : "login-panel"}>
        {user ? (
          <>
            <li id="current-user" className="current-user">
              <Link to="/profile" className="profile" title={`Profile for ${user.name}`}>
                <span>{user.name}</span>
              </Link>
            </li>
            <li className="logout">
              <a href="/logout" id="logout" accessKey="l">
                Sign out
              </a>
            </li>
          </>
        ) : (
          <li id="login">
            <Link to="/login" id="nav-login" accessKey="l" className="sign-in">
              Sign in
            </Link>
          </li>
        )}
      </ul>
    </div>
  );
}

/** Project-scoped header actions (legacy shared/_header_actions.rhtml). */
function ProjectActions({ project }: { project: NonNullable<SiteContext["project"]> }) {
  const base = `/projects/${project.identifier}`;
  return (
    <div className="current-user-actions">
      <ul className="project_actions">
        <li className="project_action">
          <div id="murmurs-drop-down">
            <div className="murmurs-chat">
              <Link to={`${base}/murmurs`}>Murmurs</Link>
            </div>
          </div>
        </li>
        <li className="project_action">
          <div className="project-admin-header">
            <Link to={`${base}/settings`}>Project admin</Link>
          </div>
        </li>
      </ul>
    </div>
  );
}

/** Which top-level pill the path selects (legacy `header_pill_class`). */
function selectedPill(pathname: string): "programs" | "projects" | "admin" | null {
  if (pathname.startsWith("/programs")) return "programs";
  if (pathname.startsWith("/projects") || pathname === "/dependencies/import-export") return "projects";
  if (pathname.startsWith("/admin") || pathname === "/register") return "admin";
  return null;
}

/** The top-level pills shown outside a project (legacy shared/_top_level_header_pills.rhtml). */
function HeaderPills({ user }: { user: NonNullable<SiteContext["user"]> }) {
  const selected = selectedPill(useLocation().pathname);
  const pill = (key: "programs" | "projects" | "admin", label: string, href: string) => (
    <li className={`header-menu-pill${selected === key ? " selected" : ""}`} id={`${key}-pill`}>
      <Link to={href}>{label}</Link>
    </li>
  );
  return (
    <div id="header-pills">
      <ul>
        {pill("programs", "Programs", "/programs")}
        {pill("projects", "Projects", "/projects")}
        {user.admin ? pill("admin", "Admin", "/admin/authentication") : null}
      </ul>
      <div style={{ clear: "both" }} />
    </div>
  );
}

/** The header (legacy layouts/_application_hd.rhtml). */
function Header({ context }: { context: SiteContext }) {
  const { user, project, tabs } = context;
  return (
    <div id="header">
      <div id="header_wrapper">
        <div id="title" className="clear_float">
          {project ? (
            <>
              <div id="project-list">
                <Link to="/projects" className="logo">
                  <img src="/images/logo.png" alt="Mingle" />
                </Link>
              </div>
              <span className="header-name">
                <Link to={`/projects/${project.identifier}/cards`}>{project.name}</Link>
              </span>
            </>
          ) : (
            <Link to="/projects" id="logo_link" className="logo">
              <img src="/images/logo.png" alt="Mingle" />
            </Link>
          )}
          <div className="header-actions clear_float">
            <ul className="actions_list">
              <li className="action_item">{project ? <ProjectActions project={project} /> : null}</li>
              <li className="action_item">
                <ProfileUtilities user={user} />
              </li>
            </ul>
          </div>
        </div>
        {project ? <ProjectTabs tabs={tabs} /> : user ? <HeaderPills user={user} /> : null}
      </div>
    </div>
  );
}

/** The fixed footbar (legacy layouts/_footbar.rhtml + shared/_copyright.rhtml). */
function Footbar() {
  return (
    <div id="ft">
      <div className="footer-links">
        <ul id="support" className="clearfix">
          <li>Copyright 2007-{new Date().getFullYear()} ThoughtWorks, Inc.</li>
          <li>
            <Link to="/projects">Projects</Link>
          </li>
        </ul>
      </div>
    </div>
  );
}

/**
 * Renders the page inside the legacy application shell.
 *
 * @param context - the root loader's site context
 * @param children - the page (the router outlet)
 */
export function SiteChrome({
  context,
  children,
}: {
  context: SiteContext;
  children: React.ReactNode;
}) {
  return (
    <div id="doc" className={context.renderingLogin ? "yui-t7 rendering-login" : "yui-t7"}>
      {context.renderingLogin ? null : <Header context={context} />}
      <div id="bd">
        <div className="page-content" id="main">
          <div className="main_inner">
            <div id="flash" />
            {children}
          </div>
        </div>
      </div>
      <Footbar />
    </div>
  );
}
