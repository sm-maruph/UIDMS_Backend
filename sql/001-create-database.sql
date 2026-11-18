/* Run as DBA in SSMS. SQL Server 2019+; SQL Server 2022+ recommended.
   Run this file separately, then 002 and 003 in order. No database is dropped. */
USE master;
GO
IF DB_ID(N'CBC_UIDMS') IS NULL
  CREATE DATABASE CBC_UIDMS COLLATE Latin1_General_100_CI_AS_SC;
GO
ALTER DATABASE CBC_UIDMS SET READ_COMMITTED_SNAPSHOT ON;
GO
