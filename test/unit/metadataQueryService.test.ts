import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetadataQueryService } from '../../src/objectExplorer/metadataQueryService';

/**
 * Creates a mock mssql.ConnectionPool and mssql.Request that captures
 * the query string and returns the provided mock recordset.
 */
function createMockPool(recordset: any[]) {
  const mockRequest = {
    input: vi.fn().mockReturnThis(),
    query: vi.fn().mockResolvedValue({ recordset }),
  };
  const mockPool = {
    request: vi.fn(() => mockRequest),
  };
  return { mockPool, mockRequest };
}

describe('MetadataQueryService', () => {
  let service: MetadataQueryService;

  beforeEach(() => {
    service = new MetadataQueryService();
  });

  describe('getDatabases', () => {
    it('returns DatabaseInfo[] with correct isSystem classification', async () => {
      const { mockPool } = createMockPool([
        { name: 'master', state: 0, database_id: 1 },
        { name: 'model', state: 0, database_id: 3 },
        { name: 'msdb', state: 0, database_id: 4 },
        { name: 'tempdb', state: 0, database_id: 2 },
        { name: 'MyAppDB', state: 0, database_id: 5 },
        { name: 'Analytics', state: 0, database_id: 6 },
      ]);

      const result = await service.getDatabases(mockPool as any);

      expect(result).toHaveLength(6);
      // System databases
      expect(result.find(d => d.name === 'master')!.isSystem).toBe(true);
      expect(result.find(d => d.name === 'model')!.isSystem).toBe(true);
      expect(result.find(d => d.name === 'msdb')!.isSystem).toBe(true);
      expect(result.find(d => d.name === 'tempdb')!.isSystem).toBe(true);
      // User databases
      expect(result.find(d => d.name === 'MyAppDB')!.isSystem).toBe(false);
      expect(result.find(d => d.name === 'Analytics')!.isSystem).toBe(false);
    });

    it('maps state codes correctly (0=online, 6=offline, 4=suspect)', async () => {
      const { mockPool } = createMockPool([
        { name: 'OnlineDB', state: 0, database_id: 5 },
        { name: 'OfflineDB', state: 6, database_id: 6 },
        { name: 'SuspectDB', state: 4, database_id: 7 },
        { name: 'RestoringDB', state: 1, database_id: 8 },
        { name: 'RecoveringDB', state: 2, database_id: 9 },
        { name: 'UnknownStateDB', state: 99, database_id: 10 },
      ]);

      const result = await service.getDatabases(mockPool as any);

      expect(result.find(d => d.name === 'OnlineDB')!.state).toBe('online');
      expect(result.find(d => d.name === 'OfflineDB')!.state).toBe('offline');
      expect(result.find(d => d.name === 'SuspectDB')!.state).toBe('suspect');
      expect(result.find(d => d.name === 'RestoringDB')!.state).toBe('restoring');
      expect(result.find(d => d.name === 'RecoveringDB')!.state).toBe('recovering');
      expect(result.find(d => d.name === 'UnknownStateDB')!.state).toBe('offline');
    });
  });

  describe('getTables', () => {
    it('returns TableMetadata[] with schema and name, isExternal=false', async () => {
      const { mockPool, mockRequest } = createMockPool([
        { schema_name: 'dbo', table_name: 'Orders' },
        { schema_name: 'sales', table_name: 'Customers' },
      ]);

      const result = await service.getTables(mockPool as any, 'MyDB');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ schema: 'dbo', name: 'Orders', isExternal: false });
      expect(result[1]).toEqual({ schema: 'sales', name: 'Customers', isExternal: false });
      expect(mockRequest.query).toHaveBeenCalledTimes(1);
      const query = mockRequest.query.mock.calls[0][0] as string;
      expect(query).toContain('USE [MyDB]');
      expect(query).toContain('sys.tables');
    });
  });

  describe('getExternalTables', () => {
    it('returns TableMetadata[] with isExternal=true', async () => {
      const { mockPool, mockRequest } = createMockPool([
        { schema_name: 'ext', table_name: 'RemoteData' },
        { schema_name: 'dbo', table_name: 'ExternalFeed' },
      ]);

      const result = await service.getExternalTables(mockPool as any, 'MyDB');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ schema: 'ext', name: 'RemoteData', isExternal: true });
      expect(result[1]).toEqual({ schema: 'dbo', name: 'ExternalFeed', isExternal: true });
      const query = mockRequest.query.mock.calls[0][0] as string;
      expect(query).toContain('sys.external_tables');
    });
  });

  describe('getViews', () => {
    it('returns ViewMetadata[] excluding sys/INFORMATION_SCHEMA schemas', async () => {
      const { mockPool, mockRequest } = createMockPool([
        { schema_name: 'dbo', view_name: 'vw_ActiveOrders' },
        { schema_name: 'reporting', view_name: 'vw_Summary' },
      ]);

      const result = await service.getViews(mockPool as any, 'MyDB');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ schema: 'dbo', name: 'vw_ActiveOrders', isSystem: false });
      expect(result[1]).toEqual({ schema: 'reporting', name: 'vw_Summary', isSystem: false });
      const query = mockRequest.query.mock.calls[0][0] as string;
      expect(query).toContain("NOT IN ('sys', 'INFORMATION_SCHEMA')");
    });
  });

  describe('getSystemViews', () => {
    it('returns ViewMetadata[] for sys/INFORMATION_SCHEMA schemas only', async () => {
      const { mockPool, mockRequest } = createMockPool([
        { schema_name: 'sys', view_name: 'objects' },
        { schema_name: 'INFORMATION_SCHEMA', view_name: 'TABLES' },
      ]);

      const result = await service.getSystemViews(mockPool as any, 'MyDB');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ schema: 'sys', name: 'objects', isSystem: true });
      expect(result[1]).toEqual({ schema: 'INFORMATION_SCHEMA', name: 'TABLES', isSystem: true });
      const query = mockRequest.query.mock.calls[0][0] as string;
      expect(query).toContain("IN ('sys', 'INFORMATION_SCHEMA')");
    });
  });

  describe('getColumns', () => {
    it('returns ColumnMetadata[] with PK/FK detection and formatted data types', async () => {
      const { mockPool } = createMockPool([
        {
          column_name: 'Id',
          type_name: 'int',
          max_length: 4,
          precision: 10,
          scale: 0,
          column_id: 1,
          is_primary_key: 1,
          is_foreign_key: 0,
        },
        {
          column_name: 'Name',
          type_name: 'nvarchar',
          max_length: 200,
          precision: 0,
          scale: 0,
          column_id: 2,
          is_primary_key: 0,
          is_foreign_key: 0,
        },
        {
          column_name: 'CategoryId',
          type_name: 'int',
          max_length: 4,
          precision: 10,
          scale: 0,
          column_id: 3,
          is_primary_key: 0,
          is_foreign_key: 1,
        },
        {
          column_name: 'Price',
          type_name: 'decimal',
          max_length: 9,
          precision: 18,
          scale: 2,
          column_id: 4,
          is_primary_key: 0,
          is_foreign_key: 0,
        },
      ]);

      const result = await service.getColumns(mockPool as any, 'MyDB', 'dbo', 'Products');

      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({
        name: 'Id',
        dataType: 'int',
        isPrimaryKey: true,
        isForeignKey: false,
        ordinalPosition: 1,
      });
      expect(result[1]).toEqual({
        name: 'Name',
        dataType: 'nvarchar(100)',
        isPrimaryKey: false,
        isForeignKey: false,
        ordinalPosition: 2,
      });
      expect(result[2]).toEqual({
        name: 'CategoryId',
        dataType: 'int',
        isPrimaryKey: false,
        isForeignKey: true,
        ordinalPosition: 3,
      });
      expect(result[3]).toEqual({
        name: 'Price',
        dataType: 'decimal(18,2)',
        isPrimaryKey: false,
        isForeignKey: false,
        ordinalPosition: 4,
      });
    });

    it('uses parameterized inputs (@schemaName, @objectName)', async () => {
      const { mockPool, mockRequest } = createMockPool([]);

      await service.getColumns(mockPool as any, 'TestDB', 'sales', 'Orders');

      expect(mockRequest.input).toHaveBeenCalledWith('schemaName', expect.anything(), 'sales');
      expect(mockRequest.input).toHaveBeenCalledWith('objectName', expect.anything(), 'Orders');
      const query = mockRequest.query.mock.calls[0][0] as string;
      expect(query).toContain('@schemaName');
      expect(query).toContain('@objectName');
    });
  });

  describe('getConstraints', () => {
    it('returns ConstraintMetadata[] with correct type mapping', async () => {
      const { mockPool } = createMockPool([
        { name: 'PK_Orders_Id', constraint_type: 'PRIMARY_KEY_CONSTRAINT' },
        { name: 'UQ_Orders_OrderNum', constraint_type: 'UNIQUE_CONSTRAINT' },
        { name: 'FK_Orders_CustomerId', constraint_type: 'FOREIGN_KEY_CONSTRAINT' },
        { name: 'CK_Orders_Amount', constraint_type: 'CHECK_CONSTRAINT' },
        { name: 'DF_Orders_Status', constraint_type: 'DEFAULT_CONSTRAINT' },
      ]);

      const result = await service.getConstraints(mockPool as any, 'MyDB', 'dbo', 'Orders');

      expect(result).toHaveLength(5);
      expect(result[0]).toEqual({ name: 'PK_Orders_Id', type: 'PRIMARY KEY' });
      expect(result[1]).toEqual({ name: 'UQ_Orders_OrderNum', type: 'UNIQUE' });
      expect(result[2]).toEqual({ name: 'FK_Orders_CustomerId', type: 'FOREIGN KEY' });
      expect(result[3]).toEqual({ name: 'CK_Orders_Amount', type: 'CHECK' });
      expect(result[4]).toEqual({ name: 'DF_Orders_Status', type: 'DEFAULT' });
    });
  });

  describe('getTriggers', () => {
    it('groups events by trigger name', async () => {
      const { mockPool } = createMockPool([
        { name: 'trg_AuditInsert', trigger_type: 'AFTER', event_type: 'INSERT' },
        { name: 'trg_AuditInsert', trigger_type: 'AFTER', event_type: 'UPDATE' },
        { name: 'trg_PreventDelete', trigger_type: 'INSTEAD OF', event_type: 'DELETE' },
      ]);

      const result = await service.getTriggers(mockPool as any, 'MyDB', 'dbo', 'Orders');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'trg_AuditInsert',
        type: 'AFTER',
        events: ['INSERT', 'UPDATE'],
      });
      expect(result[1]).toEqual({
        name: 'trg_PreventDelete',
        type: 'INSTEAD OF',
        events: ['DELETE'],
      });
    });
  });

  describe('getIndexes', () => {
    it('groups columns by index name', async () => {
      const { mockPool } = createMockPool([
        { name: 'IX_Orders_Date', index_type: 'NONCLUSTERED', is_unique: false, column_name: 'OrderDate', key_ordinal: 1 },
        { name: 'IX_Orders_Date', index_type: 'NONCLUSTERED', is_unique: false, column_name: 'CustomerId', key_ordinal: 2 },
        { name: 'PK_Orders', index_type: 'CLUSTERED', is_unique: true, column_name: 'Id', key_ordinal: 1 },
      ]);

      const result = await service.getIndexes(mockPool as any, 'MyDB', 'dbo', 'Orders');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'IX_Orders_Date',
        type: 'NONCLUSTERED',
        columns: ['OrderDate', 'CustomerId'],
      });
      expect(result[1]).toEqual({
        name: 'PK_Orders',
        type: 'UNIQUE',
        columns: ['Id'],
      });
    });
  });

  describe('getStatistics', () => {
    it('groups columns by statistic name', async () => {
      const { mockPool } = createMockPool([
        { name: 'stat_Orders_Date', column_name: 'OrderDate', stats_column_id: 1, last_updated: '2024-01-15T10:00:00Z' },
        { name: 'stat_Orders_Date', column_name: 'Status', stats_column_id: 2, last_updated: '2024-01-15T10:00:00Z' },
        { name: 'stat_Orders_Amount', column_name: 'Amount', stats_column_id: 1, last_updated: null },
      ]);

      const result = await service.getStatistics(mockPool as any, 'MyDB', 'dbo', 'Orders');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('stat_Orders_Date');
      expect(result[0].columns).toEqual(['OrderDate', 'Status']);
      expect(result[0].lastUpdated).toBeInstanceOf(Date);
      expect(result[1].name).toBe('stat_Orders_Amount');
      expect(result[1].columns).toEqual(['Amount']);
      expect(result[1].lastUpdated).toBeNull();
    });
  });

  describe('Error handling', () => {
    it('query rejection propagates the error', async () => {
      const mockRequest = {
        input: vi.fn().mockReturnThis(),
        query: vi.fn().mockRejectedValue(new Error('Query timeout expired')),
      };
      const mockPool = {
        request: vi.fn(() => mockRequest),
      };

      await expect(service.getDatabases(mockPool as any)).rejects.toThrow('Query timeout expired');
    });

    it('permission denied error propagates', async () => {
      const mockRequest = {
        input: vi.fn().mockReturnThis(),
        query: vi.fn().mockRejectedValue(new Error('The server principal does not have permission')),
      };
      const mockPool = {
        request: vi.fn(() => mockRequest),
      };

      await expect(service.getTables(mockPool as any, 'SecureDB')).rejects.toThrow(
        'The server principal does not have permission'
      );
    });
  });
});
