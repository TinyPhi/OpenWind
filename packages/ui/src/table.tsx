import * as React from "react";
import { TOKENS } from "./tokens.js";

/**
 * Mirrors apps/admin-ui/src/index.css's .data-table/.table-scroll/
 * .table-row-clickable rules. Ships no CSS of its own (tsc-only build, see
 * button.tsx/dialog.tsx) -- inline styles reading TOKENS (see tokens.ts)
 * instead of a stylesheet.
 *
 * Two accepted deviations from the source CSS (same "documented tradeoff,
 * not a bug" pattern as Button/IconButton's focus-visible approximation):
 *  - The source drops `tbody tr:last-child td`'s bottom border; replicating
 *    that here would require every row to know its position in the body.
 *    Every row keeps its border instead -- a harmless extra hairline.
 *  - The source's clickable-row hover background targets `tr:hover td`
 *    (each cell), not the row itself. Setting it directly on the <tr>
 *    renders identically in every browser this app supports and avoids
 *    threading hover state from TableRow down into TableCell.
 */

const scrollWrapperStyle: React.CSSProperties = {
  overflowX: "auto",
  WebkitOverflowScrolling: "touch",
  margin: "0 -1px",
  padding: "0 1px",
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 14,
};

const headCellStyle: React.CSSProperties = {
  padding: "10px 14px",
  textAlign: "left",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.6px",
  color: TOKENS.textMuted,
  borderBottom: `1px solid ${TOKENS.borderColor}`,
};

const bodyCellStyle: React.CSSProperties = {
  padding: "13px 14px",
  borderBottom: "1px solid hsla(225, 15%, 20%, 0.3)",
  verticalAlign: "middle",
};

const clickableRowStyle: React.CSSProperties = {
  cursor: "pointer",
  transition: `background-color ${TOKENS.transitionFast}`,
};

const rowHoverStyle: React.CSSProperties = {
  backgroundColor: TOKENS.bgTertiary,
};

export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  /** Wraps the table in the horizontally-scrollable container (.table-scroll). Default true. */
  scroll?: boolean;
}

export const Table = React.forwardRef<HTMLTableElement, TableProps>(
  function Table({ scroll = true, style, ...props }, ref) {
    const table = (
      <table ref={ref} style={{ ...tableStyle, ...style }} {...props} />
    );
    return scroll ? <div style={scrollWrapperStyle}>{table}</div> : table;
  },
);
Table.displayName = "Table";

export type TableHeaderProps = React.HTMLAttributes<HTMLTableSectionElement>;

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  TableHeaderProps
>(function TableHeader(props, ref) {
  return <thead ref={ref} {...props} />;
});
TableHeader.displayName = "TableHeader";

export type TableBodyProps = React.HTMLAttributes<HTMLTableSectionElement>;

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  TableBodyProps
>(function TableBody(props, ref) {
  return <tbody ref={ref} {...props} />;
});
TableBody.displayName = "TableBody";

export interface TableRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  /** Applies hover background + pointer cursor, mirroring .table-row-clickable. */
  clickable?: boolean;
}

export const TableRow = React.forwardRef<HTMLTableRowElement, TableRowProps>(
  function TableRow(
    { clickable = false, style, onMouseEnter, onMouseLeave, ...props },
    ref,
  ) {
    const [hovered, setHovered] = React.useState(false);
    return (
      <tr
        ref={ref}
        style={{
          ...(clickable ? clickableRowStyle : null),
          ...(clickable && hovered ? rowHoverStyle : null),
          ...style,
        }}
        onMouseEnter={(e) => {
          if (clickable) setHovered(true);
          onMouseEnter?.(e);
        }}
        onMouseLeave={(e) => {
          if (clickable) setHovered(false);
          onMouseLeave?.(e);
        }}
        {...props}
      />
    );
  },
);
TableRow.displayName = "TableRow";

export type TableHeadProps = React.ThHTMLAttributes<HTMLTableCellElement>;

export const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(
  function TableHead({ style, ...props }, ref) {
    return <th ref={ref} style={{ ...headCellStyle, ...style }} {...props} />;
  },
);
TableHead.displayName = "TableHead";

export type TableCellProps = React.TdHTMLAttributes<HTMLTableCellElement>;

export const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps>(
  function TableCell({ style, ...props }, ref) {
    return <td ref={ref} style={{ ...bodyCellStyle, ...style }} {...props} />;
  },
);
TableCell.displayName = "TableCell";
